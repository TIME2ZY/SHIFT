(function initMemoryPanel(globalScope) {
  "use strict";

  const KIND_LABELS = {
    decision: "决策",
    constraint: "约束",
    fact: "事实",
    handoff: "交接",
    "window-seal": "窗口封存",
  };

  const STATUS_LABELS = {
    captured: "已捕获",
    confirmed: "已确认",
    superseded: "已替代",
    invalidated: "已否定",
  };

  function createMemoryPanel({
    bodyEl,
    injectEl,
    filterKindEl,
    filterStatusEl,
    includeRetiredEl,
    formEl,
    memoryApi,
    getSessionId,
    escHtml,
    t = (path, fallback) => fallback || path,
    onToast,
  }) {
    if (!bodyEl || !memoryApi) {
      return {
        load() {},
        bind() {},
        setInjectPreview() {},
        clearInjectPreview() {},
      };
    }

    let loadToken = 0;
    let lastInject = null;

    function toast(message, isError) {
      if (typeof onToast === "function") onToast(message, isError);
    }

    async function load() {
      const sessionId = typeof getSessionId === "function" ? getSessionId() : null;
      const token = ++loadToken;
      if (!sessionId) {
        bodyEl.innerHTML = `<div class="memory-empty">${escHtml(
          t("memory.noSession", "暂无会话")
        )}</div>`;
        return;
      }
      bodyEl.innerHTML = `<div class="memory-empty">${escHtml(
        t("memory.loading", "加载中…")
      )}</div>`;
      try {
        const kind = filterKindEl?.value || "";
        const status = filterStatusEl?.value || "";
        const includeRetired = includeRetiredEl ? includeRetiredEl.checked : true;
        const data = await memoryApi.listMemories(sessionId, {
          kind: kind || undefined,
          status: status || undefined,
          includeRetired,
          limit: 200,
        });
        if (
          token !== loadToken ||
          (typeof getSessionId === "function" && getSessionId() !== sessionId)
        ) {
          return;
        }
        renderList(data.memories || [], data.counts || {});
      } catch (error) {
        if (
          token !== loadToken ||
          (typeof getSessionId === "function" && getSessionId() !== sessionId)
        ) {
          return;
        }
        bodyEl.innerHTML = `<div class="memory-empty memory-empty-error">${escHtml(
          t("memory.loadFailed", "加载失败") + ": " + (error.message || error)
        )}</div>`;
      }
    }

    function renderInjectPreview(payload) {
      if (!injectEl) return;
      lastInject = payload || null;
      if (!payload) {
        injectEl.hidden = true;
        injectEl.innerHTML = "";
        return;
      }
      const count = Number(payload.count) || (payload.items || []).length || 0;
      const items = Array.isArray(payload.items) ? payload.items : [];
      const title =
        count > 0
          ? t("memory.injectedSummary", "本回合注入 {{n}} 条").replace("{{n}}", String(count))
          : t("memory.injectedEmpty", "本回合未注入结构化记忆");
      const list =
        count > 0
          ? `<ul class="memory-inject-list">${items
              .map((item) => {
                const kind = KIND_LABELS[item.kind] || item.kind || "";
                const snippet = String(item.content || "").slice(0, 80);
                return `<li><span class="memory-kind">${escHtml(kind)}</span> ${escHtml(
                  snippet
                )}</li>`;
              })
              .join("")}</ul>`
          : "";
      injectEl.hidden = false;
      injectEl.innerHTML = `<div class="memory-inject-title">${escHtml(title)}</div>${list}`;
    }

    function setInjectPreview(payload) {
      renderInjectPreview(payload);
    }

    function clearInjectPreview() {
      renderInjectPreview(null);
    }

    function renderList(memories, counts) {
      if (!memories.length) {
        bodyEl.innerHTML = `<div class="memory-empty">${escHtml(
          t("memory.emptyList", "本会话暂无记忆")
        )}</div>`;
        return;
      }
      const summary = Object.entries(counts)
        .map(([status, count]) => `${STATUS_LABELS[status] || status} ${count}`)
        .join(" · ");
      const cards = memories.map((memory) => renderCard(memory)).join("");
      bodyEl.innerHTML = `
        <div class="memory-summary">${escHtml(summary || `${memories.length} 条`)}</div>
        <div class="memory-list">${cards}</div>
      `;
      bodyEl.querySelectorAll("[data-memory-action]").forEach((btn) => {
        btn.addEventListener("click", onActionClick);
      });
    }

    function renderCard(memory) {
      const kindLabel = KIND_LABELS[memory.kind] || memory.kind;
      const statusLabel = STATUS_LABELS[memory.status] || memory.status;
      const topic = memory.topic || memory.supersessionKey || "";
      const related =
        Array.isArray(memory.related) && memory.related.length
          ? `<div class="memory-meta">替代关系: ${memory.related
              .map(
                (item) =>
                  `${escHtml(item.id.slice(0, 8))}… (${escHtml(STATUS_LABELS[item.status] || item.status)})`
              )
              .join(" · ")}</div>`
          : "";
      const sources = [
        memory.sourceMessageId
          ? `消息 ${escHtml(String(memory.sourceMessageId).slice(0, 10))}…`
          : "",
        memory.sourceInvocationId
          ? `调用 ${escHtml(String(memory.sourceInvocationId).slice(0, 10))}…`
          : "",
        memory.createdBy ? `来源 ${escHtml(memory.createdBy)}` : "",
      ]
        .filter(Boolean)
        .join(" · ");

      const actions = [];
      if (memory.status === "captured") {
        actions.push(
          `<button type="button" class="memory-action" data-memory-action="confirm" data-id="${escHtml(
            memory.id
          )}">${escHtml(t("memory.confirm", "确认"))}</button>`
        );
      }
      if (memory.status === "captured" || memory.status === "confirmed") {
        actions.push(
          `<button type="button" class="memory-action is-danger" data-memory-action="invalidate" data-id="${escHtml(
            memory.id
          )}">${escHtml(t("memory.invalidate", "否定"))}</button>`
        );
      }

      return `
        <article class="memory-card status-${escHtml(memory.status)}" data-memory-id="${escHtml(
          memory.id
        )}">
          <header class="memory-card-head">
            <span class="memory-kind">${escHtml(kindLabel)}</span>
            <span class="memory-status">${escHtml(statusLabel)}</span>
          </header>
          <div class="memory-content">${escHtml(memory.content || "")}</div>
          ${topic ? `<div class="memory-meta">主题 ${escHtml(topic)}</div>` : ""}
          ${sources ? `<div class="memory-meta">${sources}</div>` : ""}
          ${related}
          <div class="memory-meta">${escHtml(memory.createdAt || "")}</div>
          ${
            actions.length
              ? `<footer class="memory-card-actions">${actions.join("")}</footer>`
              : ""
          }
        </article>
      `;
    }

    async function onActionClick(event) {
      const btn = event.currentTarget;
      const id = btn.getAttribute("data-id");
      const action = btn.getAttribute("data-memory-action");
      if (!id || !action) return;
      btn.disabled = true;
      try {
        if (action === "confirm") {
          await memoryApi.confirmMemory(id, {
            confirmedBy: "user",
            confirmationSource: "ui:memory-panel",
          });
          toast(t("memory.confirmOk", "已确认记忆"));
        } else if (action === "invalidate") {
          const reason =
            typeof globalScope.prompt === "function"
              ? globalScope.prompt(t("memory.invalidatePrompt", "否定原因（可选）"), "")
              : "";
          await memoryApi.invalidateMemory(id, {
            invalidatedBy: "user",
            reason: reason || "",
          });
          toast(t("memory.invalidateOk", "已否定记忆"));
        }
        await load();
      } catch (error) {
        toast(error.message || String(error), true);
        btn.disabled = false;
      }
    }

    async function onCreateSubmit(event) {
      event.preventDefault();
      const sessionId = typeof getSessionId === "function" ? getSessionId() : null;
      if (!sessionId) {
        toast(t("memory.noSession", "暂无会话"), true);
        return;
      }
      const form = event.currentTarget;
      const kind = form.elements.kind?.value || "fact";
      const topic = form.elements.topic?.value || "";
      const content = form.elements.content?.value || "";
      if (!content.trim()) {
        toast(t("memory.contentRequired", "请填写记忆内容"), true);
        return;
      }
      const submitBtn = form.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;
      try {
        await memoryApi.createMemory({
          sessionId,
          kind,
          topic: topic.trim() || undefined,
          content: content.trim(),
          createdBy: "user",
        });
        form.reset();
        if (form.elements.kind) form.elements.kind.value = "decision";
        toast(t("memory.createOk", "已写入记忆"));
        await load();
      } catch (error) {
        toast(error.message || String(error), true);
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    }

    function bind() {
      if (filterKindEl) filterKindEl.addEventListener("change", () => load());
      if (filterStatusEl) filterStatusEl.addEventListener("change", () => load());
      if (includeRetiredEl) includeRetiredEl.addEventListener("change", () => load());
      if (formEl) formEl.addEventListener("submit", onCreateSubmit);
    }

    return { load, bind, setInjectPreview, clearInjectPreview };
  }

  const api = { createMemoryPanel, KIND_LABELS, STATUS_LABELS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.MemoryPanel = api;
})(typeof window !== "undefined" ? window : globalThis);
