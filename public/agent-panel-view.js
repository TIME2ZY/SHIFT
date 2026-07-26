(function initAgentPanelView(globalScope) {
  "use strict";

  function budgetRailSegments(fillRatio) {
    const usedPercent = Math.min(80, Math.max(0, Number(fillRatio || 0) * 80));
    return { usedPercent, remainingPercent: Math.max(0, 80 - usedPercent) };
  }

  function createAgentPanelView(deps) {
    const {
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
      onContextBlockedChange,
    } = deps;

    function compactTokens(value) {
      const count = Number(value || 0);
      if (!Number.isFinite(count)) return "—";
      if (count >= 1_000_000)
        return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 1 : 2).replace(/\.0+$/, "")}M`;
      if (count >= 1_000)
        return `${(count / 1_000).toFixed(count >= 100_000 ? 0 : 1).replace(/\.0$/, "")}k`;
      return String(Math.round(count));
    }

    function usageEntry(agent) {
      const entries =
        state.usageSummary && Array.isArray(state.usageSummary.agents)
          ? state.usageSummary.agents
          : [];
      const stored = entries.find((entry) => entry.agentId === agent.id) || null;
      const contextWindowTokens = Number(
        stored?.context?.contextWindowTokens || agent.contextTokens || 0
      );
      const reserveRatio = Number(stored?.context?.reserveRatio ?? agent.reserveRatio ?? 0.2);
      const reserveTokens = Number(
        stored?.context?.reserveTokens || Math.floor(contextWindowTokens * reserveRatio)
      );
      const usableContextTokens = Number(
        stored?.context?.usableContextTokens || Math.max(0, contextWindowTokens - reserveTokens)
      );
      const contextUsedTokens = Number(stored?.context?.contextUsedTokens || 0);
      return {
        ...stored,
        context: {
          ...(stored?.context || {}),
          contextWindowTokens,
          reserveRatio,
          reserveTokens,
          usableContextTokens,
          contextUsedTokens,
          remainingTokens: Math.max(0, usableContextTokens - contextUsedTokens),
          budgetFillRatio: usableContextTokens > 0 ? contextUsedTokens / usableContextTokens : 0,
          contextUsageSource: stored?.context?.contextUsageSource || "char_estimated",
        },
      };
    }

    function renderBudget(item, agent) {
      const entry = usageEntry(agent);
      const context = entry.context;
      const billing = entry.billing || {};
      const sessionUsage = item.querySelector(".agent-session-usage");
      if (sessionUsage) {
        const sessionTotal = Number(billing.totalTokens || 0);
        sessionUsage.querySelector("strong").textContent =
          sessionTotal > 0 ? `${compactTokens(sessionTotal)} tokens` : "—";
        sessionUsage.title = [
          `本会话输入 ${compactTokens(billing.inputTokens)}`,
          `输出 ${compactTokens(billing.outputTokens)}`,
          `缓存 ${compactTokens(billing.cachedInputTokens)}`,
          `推理 ${compactTokens(billing.reasoningTokens)}`,
        ].join(" · ");
      }
      const { usedPercent, remainingPercent } = budgetRailSegments(context.budgetFillRatio);
      const budget = item.querySelector(".agent-tab-budget");
      const rail = item.querySelector(".context-rail");
      if (budget) budget.hidden = false;
      if (rail) {
        rail.style.setProperty("--context-used", `${usedPercent}%`);
        rail.style.setProperty("--context-remaining", `${remainingPercent}%`);
        rail.setAttribute("aria-valuenow", String(Math.round(context.contextUsedTokens)));
        rail.setAttribute("aria-valuemax", String(Math.round(context.usableContextTokens)));
      }
      const source = context.contextUsageSource === "provider_exact" ? "精确" : "估算";
      const usedEl = item.querySelector(".agent-budget-used");
      const remEl = item.querySelector(".agent-budget-remaining");
      const srcEl = item.querySelector(".agent-budget-source");
      if (usedEl) usedEl.textContent = `${compactTokens(context.contextUsedTokens)} 已用`;
      if (remEl) remEl.textContent = `${compactTokens(context.remainingTokens)} 剩余`;
      if (srcEl) srcEl.textContent = source;
      item.classList.toggle(
        "context-warning",
        context.budgetFillRatio >= 0.9 && context.budgetFillRatio < 1
      );
      item.classList.toggle("context-full", context.budgetFillRatio >= 1);
      if (budget)
        budget.title = `物理窗口 ${compactTokens(context.contextWindowTokens)} · 可用 ${compactTokens(context.usableContextTokens)} · 预留 ${compactTokens(context.reserveTokens)} · ${source}`;
    }

    function colorFor(id) {
      if (typeof agentColorIndex === "function") return String(agentColorIndex(id));
      return "1";
    }

    let lastContextBlocked = false;

    function notifyContextBlocked(blocked) {
      if (blocked === lastContextBlocked) return;
      lastContextBlocked = blocked;
      if (typeof onContextBlockedChange === "function") {
        try {
          onContextBlockedChange(blocked);
        } catch {
          /* non-fatal */
        }
      }
    }

    function renderCurrentAgent() {
      const agent = state.agents.find((a) => a.id === state.selectedAgent) ||
        state.agents[0] || {
          id: state.selectedAgent || "codex",
          label: state.selectedAgent || "codex",
        };
      const label = agentLabel(agent.id);
      const context = usageEntry(agent).context;
      const ratio = Math.max(0, context.budgetFillRatio || 0);
      const blocked = ratio >= 1;
      notifyContextBlocked(blocked);
      if (contextStatusEl) {
        contextStatusEl.hidden = false;
        contextStatusEl.classList.toggle("context-warning", ratio >= 0.9 && ratio < 1);
        contextStatusEl.classList.toggle("context-full", blocked);
        const value = contextStatusEl.querySelector("#context-status-value");
        if (value)
          value.textContent = `${Math.round(ratio * 100)}% · 余 ${compactTokens(context.remainingTokens)}`;
        contextStatusEl.title = `${label}：已用 ${compactTokens(context.contextUsedTokens)} / 可用 ${compactTokens(context.usableContextTokens)}；物理窗口 ${compactTokens(context.contextWindowTokens)}`;
      }
    }

    function applySelection(item, isSelected) {
      if (!item) return;
      item.classList.toggle("is-selected", isSelected);
      item.setAttribute("aria-checked", isSelected ? "true" : "false");
      item.tabIndex = isSelected ? 0 : -1;
    }

    function buildAgentTab(agent) {
      const item = document.createElement("article");
      item.dataset.agentColor = colorFor(agent.id);
      item.dataset.agentId = agent.id;
      // Single-select agent group — radiogroup/radio conveys the "default agent"
      // selection better than button + aria-pressed.
      item.setAttribute("role", "radio");
      item.setAttribute("aria-checked", "false");
      item.tabIndex = -1;
      item.title =
        (agent.description ? `${agent.label} (${agent.id}) — ${agent.description}\n` : "") +
        `点击设为默认 Agent · Shift+点击插入 @${agentMention(agent)}`;
      item.innerHTML = `
          <span class="agent-tab-avatar-slot"></span>
          <span class="agent-tab-name"></span>
          <span class="agent-tab-model"></span>
          <span class="agent-session-usage"><span>本会话</span><strong></strong></span>
          <span class="agent-tab-role"></span>
          <div class="agent-tab-budget" hidden>
            <div class="context-rail" role="progressbar" aria-label="上下文可用预算" aria-valuemin="0">
              <span class="context-rail-used"></span>
              <span class="context-rail-remaining"></span>
              <span class="context-rail-reserve"></span>
            </div>
            <div class="agent-budget-meta">
              <span class="agent-budget-used"></span>
              <span class="agent-budget-remaining"></span>
              <span class="agent-budget-source"></span>
            </div>
          </div>`;
      item.querySelector(".agent-tab-name").textContent = agentLabel(agent.id);
      if (globalScope.AgentAvatar) {
        const avatar = globalScope.AgentAvatar.createAgentAvatar(agent.id, {
          label: agentLabel(agent.id),
          className: "agent-avatar-panel",
        });
        const slot = item.querySelector(".agent-tab-avatar-slot");
        if (slot && avatar) slot.appendChild(avatar);
      }
      item.querySelector(".agent-tab-model").textContent = agentMeta(agent);
      item.querySelector(".agent-tab-role").textContent = agentRoleSummary(agent);
      item.addEventListener("click", (e) => {
        if (e.shiftKey) {
          insertAgentMention(agent);
          return;
        }
        setDefaultAgent(agent.id);
        if (promptEl) promptEl.focus();
      });
      item.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (e.shiftKey) insertAgentMention(agent);
          else {
            setDefaultAgent(agent.id);
            if (promptEl) promptEl.focus();
          }
        }
      });
      return item;
    }

    function refreshAgentTab(item, agent) {
      if (!item || !agent) return;
      // Cheap in-place update — preserves DOM identity so keyboard focus and any
      // pending transitions are not lost when usage refreshes after each turn.
      item.dataset.agentColor = colorFor(agent.id);
      item.title =
        (agent.description ? `${agent.label} (${agent.id}) — ${agent.description}\n` : "") +
        `点击设为默认 Agent · Shift+点击插入 @${agentMention(agent)}`;
      const nameEl = item.querySelector(".agent-tab-name");
      if (nameEl && nameEl.textContent !== agentLabel(agent.id)) {
        nameEl.textContent = agentLabel(agent.id);
      }
      const modelEl = item.querySelector(".agent-tab-model");
      if (modelEl) modelEl.textContent = agentMeta(agent);
      const roleEl = item.querySelector(".agent-tab-role");
      if (roleEl) roleEl.textContent = agentRoleSummary(agent);
      renderBudget(item, agent);
      applySelection(item, agent.id === state.selectedAgent);
    }

    function renderAgentTabs() {
      if (!agentTabsEl) return;
      // Treat the tab strip as a single-select radiogroup of agents.
      agentTabsEl.setAttribute("role", "radiogroup");
      agentTabsEl.setAttribute(
        "aria-label",
        agentTabsEl.getAttribute("aria-label") || "可用 Agents"
      );
      const knownIds = new Set(state.agents.map((a) => a && a.id).filter(Boolean));
      // Drop stale tabs whose agents have gone (e.g. catalog reload removed one).
      for (const stale of Array.from(agentTabsEl.children)) {
        const id = stale.dataset && stale.dataset.agentId;
        if (!id || !knownIds.has(id)) stale.remove();
      }
      const existing = new Map(
        Array.from(agentTabsEl.children).map((el) => [el.dataset.agentId, el])
      );
      // Rebuild in the agents' canonical order using replaceChildren with the
      // already-built elements to preserve event bindings & avatarInstances.
      const ordered = state.agents.map((agent) => {
        const cached = existing.get(agent.id);
        if (cached) {
          refreshAgentTab(cached, agent);
          existing.delete(agent.id);
          return cached;
        }
        return buildAgentTab(agent);
      });
      agentTabsEl.replaceChildren(...ordered);
      renderCurrentAgent();
    }

    // Add keyboard navigation once for the lifecycle of the container.
    if (agentTabsEl && !agentTabsEl.__shiftRadioBound) {
      agentTabsEl.__shiftRadioBound = true;
      agentTabsEl.addEventListener("keydown", (e) => {
        if (
          e.key !== "ArrowUp" &&
          e.key !== "ArrowDown" &&
          e.key !== "ArrowLeft" &&
          e.key !== "ArrowRight" &&
          e.key !== "Home" &&
          e.key !== "End"
        )
          return;
        const ids = state.agents.map((a) => a.id).filter(Boolean);
        if (ids.length === 0) return;
        e.preventDefault();
        const cur = ids.indexOf(state.selectedAgent);
        let next = cur < 0 ? 0 : cur;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (cur + 1) % ids.length;
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp")
          next = (cur - 1 + ids.length) % ids.length;
        else if (e.key === "Home") next = 0;
        else if (e.key === "End") next = ids.length - 1;
        const targetId = ids[next];
        if (!targetId) return;
        setDefaultAgent(targetId);
        const el = agentTabsEl.querySelector(`[data-agent-id="${targetId}"]`);
        if (el && typeof el.focus === "function") el.focus();
      });
    }

    return { renderAgentTabs, renderCurrentAgent };
  }

  const api = { createAgentPanelView, budgetRailSegments };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.AgentPanelView = api;
})(typeof window !== "undefined" ? window : globalThis);
