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
      addToast,
      finishStream,
      finalizeLiveAgent,
      organizeCollabMessages,
      agentLabel,
      syncComposerControls,
      onRuntimeStatusChange,
      onUsageEvent,
      onMemoryEvent,
      onMemoryInject,
      onMemoryMetrics,
      restoreDraft,
      /** Optional: when true, sendPrompt refuses to start a new run. */
      isContextBlocked,
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

    function parseSse(buffer, onEvent, stats) {
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
          // Malformed frame must not kill the whole stream reader, but track it
          // so the user can learn events were dropped.
          if (stats && typeof stats.malformed === "number") stats.malformed += 1;
          else console.warn("[chat-client] skip bad SSE frame:", error && error.message);
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
          const notice = {
            role: "system",
            agent: "system",
            content: text,
            kind: "a2a-route",
            from: data.from,
            to: data.to,
            handoffId: data.handoffId || null,
            routeStatus: data.routeStatus || data.handoffPolicy || null,
          };
          if (!Array.isArray(rt.systemNotices)) rt.systemNotices = [];
          rt.systemNotices.push(notice);
          if (active) {
            addSystem(text, "", notice);
            if (typeof organizeCollabMessages === "function") {
              organizeCollabMessages({ openLast: true });
            }
          }
          break;
        }
        case "a2a-skipped": {
          const fromLabel = agentLabel(data.from);
          const toLabel = agentLabel(data.to);
          const reason =
            data.reason === "max_depth" ? "已达 A2A 深度上限" : data.reason || "未入队";
          const text = `⏭ ${fromLabel} → ${toLabel}（${reason}，未入队）`;
          const notice = {
            role: "system",
            agent: "system",
            content: text,
            kind: "a2a-skipped",
            from: data.from,
            to: data.to,
            handoffId: data.handoffId || null,
            routeStatus: data.routeStatus || data.reason || null,
          };
          if (!Array.isArray(rt.systemNotices)) rt.systemNotices = [];
          rt.systemNotices.push(notice);
          if (active) addSystem(text, "", notice);
          break;
        }
        case "encoding-warning": {
          if (active) {
            addSystem(
              `⚠ 编码警告: ${data.message || "检测到替换字符 U+FFFD"}` +
                (data.channel ? ` (${data.channel})` : ""),
              "error"
            );
          }
          break;
        }
        case "run-degraded": {
          if (active && Array.isArray(data.reasons) && data.reasons.length) {
            addSystem(`⚠ 运行降级: ${data.reasons.join(", ")}`, "error");
          }
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

    async function sendPrompt(sourcePrompt) {
      const prompt = (sourcePrompt != null ? String(sourcePrompt) : promptEl.value).trim();
      if (!prompt) return;

      const activeRt = store().getOrCreate(state.currentSessionId || "_pending");
      if (activeRt.controller) return;

      // Central guard: button/Enter both funnel here — block when the active
      // agent's context budget is saturated (UI also disables send for a11y).
      const blocked =
        typeof isContextBlocked === "function"
          ? !!isContextBlocked()
          : !!(state && state.contextBlocked);
      if (blocked) {
        if (isActiveSession(state.currentSessionId)) {
          showToastMaybe("上下文已满 · 切换 Agent 或开新会话后再发送", { ttl: 7000 });
          setStatus("上下文已满", "error");
        }
        return;
      }

      const resolved = resolvePromptAgent(prompt);
      const targetAgent = resolved && resolved.agent ? resolved.agent : resolved;
      if (!targetAgent || !targetAgent.id) {
        addSystem("没有可用的 Agent，请先加载模型列表", "error");
        setStatus("无可用模型", "error");
        promptEl.focus();
        return;
      }

      let sid = state.currentSessionId;
      if (!sid) {
        try {
          const session = await sessionApi.createSession();
          sid = session.id;
          state.currentSessionId = sid;
        } catch (error) {
          addSystem(error.message, "error");
          return;
        }
      }

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
      const runStats = { malformed: 0, seenDone: false };

      createMessage({ role: "user", agent: targetAgent.id, content: prompt });
      // Always clear the composer: the prompt now lives in the transcript bubble.
      // Callers restore it separately when they wish to surface a re-send draft.
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
          retryable: false,
          timeoutMs: Infinity, // streaming response, server may sit silent on long-running tool calls
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
          buf = parseSse(
            buf,
            (event, data) => {
              if (event === "done") runStats.seenDone = true;
              handleSseEvent(event, data, streamCtx);
            },
            runStats
          );
        }
        if (runStats.malformed > 0 && isActiveSession(sid)) {
          showToastMaybe(`丢失 ${runStats.malformed} 个事件（流可能不完整）`, {
            ttl: 7000,
          });
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
          // Restore the prompt so the user keeps their work after a manual stop.
          // Only fill the composer if the user has not started a new draft.
          if (isActiveSession(sid) && promptEl && !promptEl.value.trim()) {
            const stored = lastSlotPrompt(sid);
            if (stored) fillComposer(sid, stored);
          }
        } else {
          store().endRun(sid, { controller, status: "error", error: error.message || "连接中断" });
          if (isActiveSession(sid)) {
            setStatus("错误", "error");
            addSystem(error.message || "连接中断", "error");
          }
          // Run dropped mid-flight without completing — surface a non-blocking
          // recovery affordance instead of silently leaving a dead bubble.
          if (isActiveSession(sid)) {
            offerRetry(sid, "连接中断 · 重试本轮");
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
          if (!current.doneReceived && !controller.signal.aborted && !runStats.seenDone) {
            store().endRun(sid, { controller, status: "error", error: "连接意外中断" });
            if (isActiveSession(sid)) {
              setStatus("错误", "error");
              addSystem("连接意外中断", "error");
              offerRetry(sid, "连接意外中断 · 重试本轮");
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

    // Injected restoreDraft carries (sid, value). If value omitted, callers
    // expect lastPrompt to be restored from the session slot. The injected
    // implementation is responsible for re-running autoGrow / skills refresh.
    function fillComposer(sid, value) {
      if (!promptEl) return;
      if (typeof restoreDraft === "function") {
        try {
          restoreDraft(sid, value);
          return;
        } catch {
          /* fall through to direct set below */
        }
      }
      promptEl.value = value != null ? String(value) : lastSlotPrompt(sid);
      if (typeof promptEl.dispatchEvent === "function") {
        promptEl.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }

    function lastSlotPrompt(sid) {
      const slot = state.sessions && state.sessions[sid || ""];
      return slot && slot.lastPrompt ? slot.lastPrompt : "";
    }

    function lastSlotAgent(sid) {
      const slot = state.sessions && state.sessions[sid || ""];
      return slot && slot.lastAgent ? slot.lastAgent : state.selectedAgent || "codex";
    }

    function showToastMaybe(message, options) {
      if (typeof addToast === "function") addToast(message, options || {});
    }

    // Surface a non-blocking recovery affordance after a network-failed run.
    // Pre-fill the last prompt (unless the user is already composing), then
    // offer an explicit CTA that re-sends. We never auto-send on failure so a
    // mid-draft is not clobbered without a deliberate click.
    function offerRetry(sid, message) {
      const stored = lastSlotPrompt(sid);
      if (!stored) return;
      const activeEl =
        typeof globalScope.document !== "undefined" && globalScope.document
          ? globalScope.document.activeElement
          : null;
      const userIsComposing = promptEl && promptEl === activeEl && promptEl.value.trim().length > 0;
      if (!userIsComposing) fillComposer(sid, stored);
      showToastMaybe(message, {
        ttl: 12_000,
        actionLabel: "填回并重试",
        onClick: () => {
          if (!isActiveSession(sid)) return;
          fillComposer(sid, stored);
          if (promptEl && typeof promptEl.focus === "function") promptEl.focus();
          // Fire-and-forget: sendPrompt is async; errors surface via its own path.
          Promise.resolve(sendPrompt(stored)).catch(() => {});
        },
      });
    }

    return {
      parseSse,
      handleSseEvent,
      sendPrompt,
      lastSlotPrompt,
      lastSlotAgent,
    };
  }

  const api = { createChatClient };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.ChatClient = api;
})(typeof window !== "undefined" ? window : globalThis);
