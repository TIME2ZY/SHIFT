(function initEmptyState(globalScope) {
  "use strict";

  const DEFAULT_EMPTY_PROMPTS = [
    { label: "梳理项目", prompt: "帮我梳理当前项目结构，并给出优先改进点。" },
    { label: "审查 diff", prompt: "审查最近改动的 diff，指出风险与可改进处。" },
    { label: "并行分工", prompt: "把任务拆成可并行的子任务，并建议合适的 Agent 分工。" },
  ];

  // Per-agent example prompts surface the @-handoff affordance once a CLI is
  // detected, instead of leaving the @-mention discoverability to placeholder text.
  const AGENT_PROMPT_TEMPLATES = {
    codex: { label: "提问 · Codex", prompt: "@codex 帮我把这个目标拆清楚，列出权衡和前提。" },
    gemini: { label: "发散 · Gemini", prompt: "@gemini 给这个需求三种方向，再让 @codex 收敛。" },
    grok: {
      label: "实现 · Grok",
      prompt: "@grok 在隔离 worktree 中实现这个需求，完成后交给 @opencode 审查。",
    },
    opencode: {
      label: "审查 · OpenCode",
      prompt: "@opencode 审查最近的代码改动，标记风险与质量。",
    },
  };

  function createEmptyState({ chipsEl, promptEl, onAfterFill }) {
    function getStateAgents() {
      // Resolved lazily so callers do not need to pass `state` directly.
      const state = globalScope.__shiftState;
      return Array.isArray(state && state.agents) ? state.agents : [];
    }

    function renderEmptyChips(agents) {
      if (!chipsEl) return;
      const list = Array.isArray(agents) ? agents : getStateAgents();
      const items = DEFAULT_EMPTY_PROMPTS.slice();
      let count = 0;
      for (const agent of list) {
        if (!agent || !agent.id) continue;
        const tpl = AGENT_PROMPT_TEMPLATES[agent.id];
        if (!tpl) continue;
        items.push({ label: tpl.label, prompt: tpl.prompt });
        count += 1;
        if (count >= 2) break;
      }
      if (items.length === 0) {
        chipsEl.setAttribute("hidden", "");
        return;
      }
      if (list.length > 0) chipsEl.removeAttribute("hidden");
      chipsEl.replaceChildren(
        ...items.map((item) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "empty-chip";
          btn.setAttribute("data-prompt", item.prompt);
          btn.textContent = item.label;
          return btn;
        })
      );
    }

    function fillFromChip(text) {
      if (!promptEl || !text || !text.trim()) return;
      promptEl.value = text.trim();
      promptEl.focus();
      if (typeof onAfterFill === "function") onAfterFill(promptEl);
      try {
        promptEl.setSelectionRange(promptEl.value.length, promptEl.value.length);
      } catch {
        /* ignore */
      }
    }

    function bindClick() {
      if (!chipsEl) return;
      chipsEl.addEventListener("click", (e) => {
        const chip = e.target && e.target.closest ? e.target.closest(".empty-chip") : null;
        if (!chip) return;
        fillFromChip(chip.getAttribute("data-prompt") || chip.textContent || "");
      });
    }

    return { renderEmptyChips, fillFromChip, bindClick };
  }

  const api = { createEmptyState, DEFAULT_EMPTY_PROMPTS, AGENT_PROMPT_TEMPLATES };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.EmptyState = api;
})(typeof window !== "undefined" ? window : globalThis);
