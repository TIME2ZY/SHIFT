(function initMemoryPanel(globalScope) {
  "use strict";

  const PRODUCT_KINDS = ["decision", "constraint", "fact"];

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
    filterKindEl = null,
    includeRetiredEl = null,
    memoryApi,
    getSessionId,
    escHtml,
    t = (path, fallback) => fallback || path,
    onToast,
    promptImpl,
    productOnly = true,
    showConfirm = false,
  }) {
    // bodyEl is optional: context UI attaches conclusions to recall turns instead of a list.
    if (!memoryApi && !injectEl) {
      return {
        load() {},
        bind() {},
        setInjectPreview() {},
        clearInjectPreview() {},
        setContextSnapshot() {},
      };
    }

    let loadToken = 0;
    let injectPreview = null;
    let contextSnapshot = null;

    function toast(message, isError) {
      if (typeof onToast === "function") onToast(message, isError);
    }

    async function load() {
      if (!bodyEl || !memoryApi) return;
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
        const includeRetired = includeRetiredEl ? includeRetiredEl.checked : false;
        const data = await memoryApi.listMemories(sessionId, {
          kind: kind || undefined,
          includeRetired,
          limit: 200,
        });
        if (
          token !== loadToken ||
          (typeof getSessionId === "function" && getSessionId() !== sessionId)
        ) {
          return;
        }
        let memories = data.memories || [];
        if (productOnly) {
          memories = memories.filter((item) => PRODUCT_KINDS.includes(item.kind));
        }
        renderList(memories, data.counts || {});
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

    function injectMarkup(payload) {
      if (!payload) return "";
      const count = Number(payload.count) || (payload.items || []).length || 0;
      const items = Array.isArray(payload.items) ? payload.items : [];
      const availability = payload.availability ||
        payload.stats?.availability || { state: "available" };
      let title =
        count > 0
          ? t("memory.injectedSummary", "本回合注入 {{n}} 条").replace("{{n}}", String(count))
          : t("memory.injectedEmpty", "本回合未注入结构化记忆");
      if (availability.state === "unavailable") {
        title = t("memory.injectedUnavailable", "记忆系统暂时不可用（非空库）");
      } else if (availability.state === "degraded") {
        title = t("memory.injectedDegraded", "记忆检索降级") + (count > 0 ? ` · ${count}` : "");
      }
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
      const warn =
        availability.state === "unavailable" || availability.state === "degraded"
          ? `<div class="memory-inject-warn" data-availability="${escHtml(
              availability.state
            )}">${escHtml(availability.reason || availability.state)}</div>`
          : "";
      return `<section class="memory-inject-block"><div class="memory-inject-title">${escHtml(
        title
      )}</div>${warn}${list}</section>`;
    }

    function contextMarkup(payload) {
      const context = payload?.context || payload;
      if (!context || typeof context !== "object") return "";
      const digest = context.digest && typeof context.digest === "object" ? context.digest : null;
      const handoffs = Array.isArray(context.handoffs) ? context.handoffs.slice(0, 5) : [];
      const suggestions = Array.isArray(context.pendingSuggestions)
        ? context.pendingSuggestions.slice(0, 5)
        : [];
      if (!digest && handoffs.length === 0 && suggestions.length === 0) return "";

      const digestHtml = digest?.summary
        ? `<div class="memory-context-digest">${escHtml(String(digest.summary).slice(0, 1600))}</div>`
        : "";
      const handoffHtml =
        handoffs.length > 0
          ? `<div class="memory-context-subtitle">当前交接</div><ul class="memory-inject-list">${handoffs
              .map(
                (item) =>
                  `<li><span class="memory-kind">${escHtml(
                    KIND_LABELS.handoff
                  )}</span> ${escHtml(String(item.content || "").slice(0, 240))}</li>`
              )
              .join("")}</ul>`
          : "";
      const suggestionHtml =
        suggestions.length > 0
          ? `<div class="memory-context-subtitle">待确认候选</div><ul class="memory-inject-list">${suggestions
              .map(
                (item) =>
                  `<li><span class="memory-kind">${escHtml(
                    KIND_LABELS[item.proposedKind] || item.proposedKind || "候选"
                  )}</span> ${escHtml(String(item.content || "").slice(0, 200))}</li>`
              )
              .join("")}</ul>`
          : "";
      return `<section class="memory-context-snapshot"><div class="memory-inject-title">SQLite 恢复的上下文</div>${digestHtml}${handoffHtml}${suggestionHtml}</section>`;
    }

    function renderStatus() {
      if (!injectEl) return;
      const markup = [injectMarkup(injectPreview), contextMarkup(contextSnapshot)]
        .filter(Boolean)
        .join("");
      injectEl.hidden = !markup;
      injectEl.innerHTML = markup;
    }

    function setInjectPreview(payload) {
      injectPreview = payload || null;
      renderStatus();
    }

    function clearInjectPreview() {
      injectPreview = null;
      renderStatus();
    }

    function setContextSnapshot(payload) {
      contextSnapshot = payload || null;
      renderStatus();
    }

    function renderList(memories) {
      if (!memories.length) {
        bodyEl.innerHTML = `<div class="memory-empty">${escHtml(
          t("memory.emptyList", "还没有沉淀的结论。Agent 确认决策后会自动出现在这里。")
        )}</div>`;
        return;
      }
      const summary = `${memories.length} 条结论`;
      const cards = memories.map((memory) => renderCard(memory)).join("");
      bodyEl.innerHTML = `
        <div class="memory-summary">${escHtml(summary)}</div>
        <div class="memory-list">${cards}</div>
      `;
      bodyEl.querySelectorAll("[data-memory-action]").forEach((btn) => {
        btn.addEventListener("click", onActionClick);
      });
    }

    function formatWhen(iso) {
      if (!iso) return "";
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return String(iso);
      const pad = (n) => String(n).padStart(2, "0");
      return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function renderCard(memory) {
      const kindLabel = KIND_LABELS[memory.kind] || memory.kind;
      const statusLabel = STATUS_LABELS[memory.status] || memory.status;
      const topic = memory.topic || memory.supersessionKey || "";
      // Prefer human "which turn produced this" over opaque ids.
      const fromAgent = memory.createdBy ? String(memory.createdBy) : "";
      const inv = memory.sourceInvocationId ? String(memory.sourceInvocationId) : "";
      const invShort = inv ? (inv.length > 14 ? `${inv.slice(0, 10)}…` : inv) : "";
      const originParts = [];
      if (fromAgent) originParts.push(fromAgent);
      if (invShort) originParts.push(`调用 ${invShort}`);
      if (memory.createdAt) originParts.push(formatWhen(memory.createdAt));
      const origin = originParts.join(" · ");

      const actions = [];
      if (showConfirm && memory.status === "captured") {
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
          ${
            origin
              ? `<div class="memory-meta memory-origin">${escHtml(
                  t("memory.fromTurn", "来自")
                )} ${escHtml(origin)}</div>`
              : ""
          }
          ${
            actions.length ? `<footer class="memory-card-actions">${actions.join("")}</footer>` : ""
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
            confirmationSource: "ui:context-panel",
          });
          toast(t("memory.confirmOk", "已确认记忆"));
        } else if (action === "invalidate") {
          // Don't block on a native prompt() dialog. Callers inject a
          // promptImpl returning { reason, cancelled }; without one, fall
          // back to an empty reason and toast about the limitation.
          let reason = "";
          if (typeof promptImpl === "function") {
            try {
              const out = await promptImpl({
                message: t("memory.invalidatePrompt", "否定原因（可选）"),
                defaultValue: "",
              });
              if (out && out.cancelled) {
                btn.disabled = false;
                return;
              }
              reason = (out && out.reason) || "";
            } catch {
              /* user dismissed — keep flow with empty reason */
            }
          } else if (typeof globalScope.prompt === "function") {
            reason = globalScope.prompt(t("memory.invalidatePrompt", "否定原因（可选）"), "") || "";
          }
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

    function bind() {
      if (filterKindEl) filterKindEl.addEventListener("change", () => load());
      if (includeRetiredEl) includeRetiredEl.addEventListener("change", () => load());
    }

    return { load, bind, setInjectPreview, clearInjectPreview, setContextSnapshot };
  }

  const api = { createMemoryPanel, KIND_LABELS, STATUS_LABELS, PRODUCT_KINDS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.MemoryPanel = api;
})(typeof window !== "undefined" ? window : globalThis);
