(function initChatClient(globalScope) {
  "use strict";

  function createChatClient(deps) {
    const {
      state,
      runtimeStore,
      promptEl,
      useWorktreeInput,
      resolvePromptAgent,
      addSystem,
      setStatus,
      sessionApi,
      createMessage,
      hideMentionMenu,
      fetchImpl,
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
      onUsageEvent,
      onMemoryEvent,
      onMemoryInject,
      onMemoryMetrics,
    } = deps;

    function store() {
      return runtimeStore || state.runtimeStore;
    }

    function isActiveSession(sessionId) {
      return !state.currentSessionId || state.currentSessionId === sessionId;
    }

    function notifyStatus(sessionId) {
      if (typeof onRuntimeStatusChange === "function") onRuntimeStatusChange(sessionId);
    }

    function syncComposer(sessionId) {
      if (typeof syncComposerControls === "function" && isActiveSession(sessionId)) {
        syncComposerControls();
      }
    }

    function parseSse(buffer, onEvent) {
      let rest = String(buffer || "").replace(/\r\n/g, "\n");
      let idx;
      while ((idx = rest.indexOf("\n\n")) !== -1) {
        const frame = rest.slice(0, idx);
        rest = rest.slice(idx + 2);
        const lines = frame.split("\n");
        const eventLine = lines.find((line) => line.startsWith("event: "));
        const dataLines = lines
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6));
        if (!eventLine || dataLines.length === 0) continue;
        try {
          onEvent(eventLine.slice(7), JSON.parse(dataLines.join("\n")));
        } catch (error) {
          // Malformed frame must not kill the whole stream reader.
          console.warn("[chat-client] skip bad SSE frame:", error && error.message);
        }
      }
      return rest;
    }

    function handleSseEvent(event, data, ctx = {}) {
      const sessionId = (ctx && ctx.sessionId) || state.currentSessionId || "_pending";
      const rt = store().getOrCreate(sessionId);
      const active = isActiveSession(sessionId);

      switch (event) {
        case "session": {
          const nextId = data && data.sessionId ? data.sessionId : "";
          if (nextId && nextId !== sessionId) {
            store().rekey(sessionId, nextId);
            if (ctx) ctx.sessionId = nextId;
          }
          const boundId = (ctx && ctx.sessionId) || nextId || sessionId;
          if (active || !state.currentSessionId) {
            state.currentSessionId = boundId;
            sessionController.loadSessions();
            loadProjectDir(boundId);
            loadWorktreeStatus();
            if (state.rightPanelTab === "workspace") {
              loadWorkspaceState();
            }
          } else if (typeof sessionController.refreshSessionList === "function") {
            sessionController.refreshSessionList();
          }
          break;
        }
        case "skills-active":
          if (active) renderSkillTags(data.skills);
          break;
        case "agent-start":
          if (data.invocationId) rt.liveInvocations.set(data.agent, data.invocationId);
          showThinking(data.agent, sessionId);
          break;
        case "agent-event":
          rt.hasStructuredEvents = true;
          applyAgentEvent(data, sessionId);
          if (data && data.type === "usage.update" && typeof onUsageEvent === "function") {
            onUsageEvent(data, sessionId);
          }
          break;
        case "message":
          if (rt.hasStructuredEvents) break;
          appendLive(data.agent, data.text, sessionId);
          break;
        case "stderr":
          if (active) addDebug(data.agent, data.text);
          break;
        case "error":
          rt.status = "error";
          rt.lastError = data.message || "error";
          notifyStatus(sessionId);
          if (active) addSystem(data.message, "error");
          break;
        case "context-warning":
          if (active) setStatus("上下文接近上限");
          break;
        case "sealed":
          finishStream("上下文已封存", sessionId);
          if (active) addSystem("context overflow: 已停止继续路由");
          break;
        case "agent-exit": {
          const failed = data.code !== 0;
          if (failed) {
            rt.status = "error";
            notifyStatus(sessionId);
            if (active) {
              addSystem(
                `${agentLabel(data.agent)} exited with ${data.code ?? data.signal}`,
                "error"
              );
            }
          }
          // Per-agent finalize so A2A handoffs don't leave the prior agent on "输出中".
          // Also drops the agent from liveMessages to avoid remount/history duplicates.
          if (typeof finalizeLiveAgent === "function") {
            finalizeLiveAgent(data.agent, sessionId, { error: failed, usage: data.usage || null });
          } else {
            const item = rt.liveMessages.get(data.agent);
            if (item && item.setBadge) item.setBadge(failed ? "error" : "done");
            if (item) rt.liveMessages.delete(data.agent);
          }
          break;
        }
        case "a2a-route": {
          const fromLabel = agentLabel(data.from);
          const toLabel = agentLabel(data.to);
          const degraded = data.handoffDegraded === true;
          const text = degraded
            ? `🔄 ${fromLabel} → ${toLabel}（交接包不完整）`
            : `🔄 ${fromLabel} → ${toLabel}`;
          // Always buffer for session remount; only paint when this session is visible.
          // Server also persists this as a system message for hard reloads.
          if (!Array.isArray(rt.systemNotices)) rt.systemNotices = [];
          rt.systemNotices.push({
            role: "system",
            agent: "system",
            content: text,
            kind: "a2a-route",
          });
          if (active) addSystem(text);
          break;
        }
        case "a2a-skipped": {
          const fromLabel = agentLabel(data.from);
          const toLabel = agentLabel(data.to);
          const reason =
            data.reason === "max_depth" ? "已达 A2A 深度上限" : data.reason || "未入队";
          const text = `⏭ ${fromLabel} → ${toLabel}（${reason}，未入队）`;
          if (!Array.isArray(rt.systemNotices)) rt.systemNotices = [];
          rt.systemNotices.push({
            role: "system",
            agent: "system",
            content: text,
            kind: "a2a-skipped",
          });
          if (active) addSystem(text);
          break;
        }
        case "memory":
          if (typeof onMemoryEvent === "function") {
            onMemoryEvent(data, sessionId);
          }
          break;
        case "memory-inject":
          if (typeof onMemoryInject === "function") {
            onMemoryInject(data, sessionId);
          }
          break;
        case "memory-metrics":
          if (typeof onMemoryMetrics === "function") {
            onMemoryMetrics(data, sessionId);
          }
          break;
        case "done":
          finishStream("就绪", sessionId);
          break;
      }
    }

    async function sendPrompt() {
      const prompt = promptEl.value.trim();
      if (!prompt) return;

      const activeRt = store().getOrCreate(state.currentSessionId || "_pending");
      if (activeRt.controller) return;

      const resolved = resolvePromptAgent(prompt);
      const targetAgent = resolved && resolved.agent ? resolved.agent : resolved;
      if (!targetAgent || !targetAgent.id) {
        addSystem("没有可用的 Agent，请先加载模型列表", "error");
        setStatus("无可用模型", "error");
        promptEl.focus();
        return;
      }

      if (!state.currentSessionId) {
        try {
          const session = await sessionApi.createSession();
          state.currentSessionId = session.id;
        } catch (error) {
          addSystem(error.message, "error");
          return;
        }
      }

      const sid = state.currentSessionId;
      if (!state.sessions) state.sessions = {};
      if (!state.sessions[sid]) state.sessions[sid] = { lastPrompt: "", lastAgent: "codex" };
      state.sessions[sid].lastPrompt = prompt;
      state.sessions[sid].lastAgent = targetAgent.id;
      state.lastPrompt = prompt;
      state.lastAgent = targetAgent.id;
      state.selectedAgent = targetAgent.id;

      const controller = new AbortController();
      const rt = store().beginRun(sid, controller);
      const streamCtx = { sessionId: sid };

      createMessage({ role: "user", agent: targetAgent.id, content: prompt });
      promptEl.value = "";
      hideMentionMenu();
      notifyStatus(sid);
      syncComposer(sid);

      try {
        const res = await fetchImpl("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agent: targetAgent.id,
            prompt,
            sessionId: sid,
            projectDir: state.projectDir || undefined,
            useWorktree: useWorktreeInput.checked,
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          store().endRun(sid, { controller, status: "error", error: err.error || res.statusText });
          notifyStatus(sid);
          if (isActiveSession(sid)) {
            addSystem(err.error || `${res.status} ${res.statusText}`, "error");
            setStatus("错误", "error");
          }
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          buf = parseSse(buf, (event, data) => handleSseEvent(event, data, streamCtx));
        }
      } catch (error) {
        flushPendingLiveRender(sid);
        const aborted = error.name === "AbortError";
        if (aborted) {
          store().endRun(sid, { controller, status: "idle", aborted: true });
          if (isActiveSession(sid)) {
            setStatus("已停止");
            addSystem("已停止", "error");
          }
        } else {
          store().endRun(sid, { controller, status: "error", error: error.message || "连接中断" });
          if (isActiveSession(sid)) {
            setStatus("错误", "error");
            addSystem(error.message || "连接中断", "error");
          }
        }
        // Prefer full finalize (deferred MD for long text) over wiping bubble.innerHTML.
        const agents = [...rt.liveMessages.keys()];
        if (typeof finalizeLiveAgent === "function") {
          for (const agent of agents) {
            finalizeLiveAgent(agent, sid, { error: !aborted });
          }
        } else {
          for (const [, item] of rt.liveMessages) {
            if (item.setBadge) item.setBadge("done");
          }
        }
        notifyStatus(sid);
      } finally {
        const current = store().get(sid);
        const stillOwnController = current && current.controller === controller;
        if (stillOwnController) {
          if (!current.doneReceived && !controller.signal.aborted) {
            store().endRun(sid, { controller, status: "error", error: "连接意外中断" });
            if (isActiveSession(sid)) {
              setStatus("错误", "error");
              addSystem("连接意外中断", "error");
            }
          } else if (controller.signal.aborted) {
            store().endRun(sid, { controller, status: "idle", aborted: true });
          } else {
            store().endRun(sid, {
              controller,
              status: current.status === "error" ? "error" : "done",
            });
          }
          notifyStatus(sid);
        }
        syncComposer(sid);
      }
    }

    return {
      parseSse,
      handleSseEvent,
      sendPrompt,
    };
  }

  const api = { createChatClient };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.ChatClient = api;
})(typeof window !== "undefined" ? window : globalThis);
