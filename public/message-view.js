(function initMessageView(globalScope) {
  "use strict";

  // History process-trace hydrate always goes through an idle queue so
  // session switches do not fan out dozens of parallel API calls.
  // MESSAGE_VIRTUAL_THRESHOLD is retained for future list virtualization.
  const MESSAGE_VIRTUAL_THRESHOLD = 250;
  const HYDRATE_CHUNK_SIZE = 4;
  /** px: user is "stuck to bottom" when within this distance of the end */
  const STICK_BOTTOM_PX = 96;
  const USAGE_FIELDS = Object.freeze([
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningTokens",
    "totalTokens",
    "costUsd",
  ]);

  function normalizedUsage(input = {}) {
    const usage = {};
    for (const field of USAGE_FIELDS) {
      const value = Number(input && input[field]);
      usage[field] = Number.isFinite(value) && value > 0 ? value : 0;
    }
    if (usage.totalTokens === 0 && usage.inputTokens + usage.outputTokens > 0) {
      usage.totalTokens = usage.inputTokens + usage.outputTokens;
    }
    return usage;
  }

  function compactUsageTokens(value) {
    const count = Number(value || 0);
    if (!Number.isFinite(count)) return "—";
    if (count >= 1_000_000)
      return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 1 : 2).replace(/\.0+$/, "")}M`;
    if (count >= 1_000)
      return `${(count / 1_000).toFixed(count >= 100_000 ? 0 : 1).replace(/\.0$/, "")}k`;
    return String(Math.round(count));
  }

  function aggregateInvocationUsage(events = []) {
    const billing = normalizedUsage();
    const accounted = normalizedUsage();
    let highestScope = -1;
    const scopeRank = { step: 0, turn: 1, run: 2 };

    for (const record of Array.isArray(events) ? events : []) {
      const event = record && record.payload && typeof record.payload === "object"
        ? record.payload
        : record;
      if (!event || (record.kind !== "usage.update" && event.type !== "usage.update")) continue;
      const rank = scopeRank[event.scope] ?? 0;
      if (rank < highestScope) continue;
      if (event.mode === "cumulative") {
        for (const field of USAGE_FIELDS) {
          if (typeof event[field] !== "number") continue;
          billing[field] = Math.max(0, billing[field] + event[field] - accounted[field]);
          accounted[field] = event[field];
        }
        highestScope = rank;
      } else if (rank === highestScope || highestScope < 0) {
        for (const field of USAGE_FIELDS) {
          if (typeof event[field] !== "number") continue;
          billing[field] += event[field];
          accounted[field] += event[field];
        }
        highestScope = rank;
      }
    }
    return normalizedUsage(billing);
  }

  function resolveProcessHelpers() {
    if (globalScope.MessageProcessHelpers) return globalScope.MessageProcessHelpers;
    if (typeof module !== "undefined" && module.exports && typeof require === "function") {
      try {
        return require("./message-process-helpers.js");
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  function resolveMarkdownLite() {
    if (globalScope.MarkdownLite) return globalScope.MarkdownLite;
    if (typeof module !== "undefined" && module.exports && typeof require === "function") {
      try {
        return require("./markdown-lite.js");
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  function resolveMsgLocale() {
    const pack = globalScope.Locale || globalScope.LocaleZhCN;
    if (pack && pack.locale && pack.locale.message) return pack.locale;
    if (typeof module !== "undefined" && module.exports && typeof require === "function") {
      try {
        return require("./locale-zh-CN.js").locale;
      } catch {
        /* ignore */
      }
    }
    return {
      badge: { thinking: "思考中", writing: "输出中", error: "异常退出" },
      message: {
        copy: "复制消息",
        copyOk: "已复制",
        copyFail: "失败",
        thinkingProcess: "思考过程",
        thinkingProcessChars: (n) => `思考过程 · ${n} 字`,
        process: "执行过程",
        running: "运行中",
        done: "完成",
        success: "成功",
        failed: "失败",
        noTools: "无工具调用",
        progressDone: (n) => `进度 · ${n} 步已完成`,
        progressPartial: (done, total) => `进度 · ${done}/${total}`,
      },
    };
  }

  /**
   * Shared process-panel DOM renderer (locale injected).
   * Pure aggregation lives in MessageProcessHelpers.aggregateProcessBuckets.
   * Used by message hydrate and recall expand — one code path for both.
   */
  function createProcessPanelRenderer(options = {}) {
    const helpers = resolveProcessHelpers() || {};
    const L = options.locale || resolveMsgLocale();
    const msg = (L && L.message) || {};
    const truncateDisplay =
      typeof helpers.truncateDisplay === "function"
        ? helpers.truncateDisplay
        : (t, max = 160) => {
            const v = String(t || "");
            return v.length > max ? `${v.slice(0, max - 1)}…` : v;
          };
    const toolDetailFromEvent =
      typeof helpers.toolDetailFromEvent === "function" ? helpers.toolDetailFromEvent : () => "";
    const processSummaryFromEvent =
      typeof helpers.processSummaryFromEvent === "function"
        ? helpers.processSummaryFromEvent
        : () => "";
    const aggregateProcessBuckets =
      typeof helpers.aggregateProcessBuckets === "function"
        ? helpers.aggregateProcessBuckets
        : () => ({ subById: new Map(), toolById: new Map(), commandByKey: new Map() });
    const isProcessBucketsEmpty =
      typeof helpers.isProcessBucketsEmpty === "function"
        ? helpers.isProcessBucketsEmpty
        : (b) => !b || (!b.subById?.size && !b.toolById?.size && !b.commandByKey?.size);
    const textDeltaSummary =
      typeof helpers.textDeltaSummary === "function" ? helpers.textDeltaSummary : () => "";

    function countProcessSteps(panel) {
      if (!panel) return 0;
      return panel.querySelectorAll(".live-subagent, .live-tool-row").length;
    }

    function updateProcessDetailsLabel(details) {
      if (!details) return;
      const summary =
        details.querySelector(":scope > .msg-process-summary") ||
        details.querySelector(".msg-process-summary");
      if (!summary) return;
      const panel = details.querySelector(".live-subagents");
      const n = countProcessSteps(panel);
      summary.textContent = n > 0 ? `执行过程 · ${n} 步` : msg.process || "执行过程";
    }

    function wrapProcessDetails(panel, { open = false, live = false } = {}) {
      if (!panel) return null;
      if (panel.classList && panel.classList.contains("msg-process")) {
        panel.open = open;
        if (!live) panel.removeAttribute("data-live");
        else panel.dataset.live = "true";
        updateProcessDetailsLabel(panel);
        return panel;
      }
      const details = document.createElement("details");
      details.className = "msg-process";
      details.open = open;
      if (live) details.dataset.live = "true";
      const summary = document.createElement("summary");
      summary.className = "msg-process-summary";
      summary.textContent = msg.process || "执行过程";
      if (panel.parentNode) panel.parentNode.insertBefore(details, panel);
      details.append(summary, panel);
      updateProcessDetailsLabel(details);
      return details;
    }

    function appendTraceRow(panel, fields) {
      const row = document.createElement("div");
      row.className = "live-subagent live-tool-row status-" + (fields.status || "done");
      if (fields.traceKind) row.dataset.traceKind = fields.traceKind;
      if (fields.traceId != null && fields.traceId !== "") {
        row.dataset.traceId = String(fields.traceId);
      }
      if (Array.isArray(fields.eventNos) && fields.eventNos.length) {
        row.dataset.eventNos = fields.eventNos.join(",");
      }
      const head = document.createElement("div");
      head.className = "live-subagent-head";
      const name = document.createElement("span");
      name.className = "live-subagent-name";
      name.textContent = fields.name || "tool";
      const status = document.createElement("span");
      status.className = "live-subagent-status status-" + (fields.status || "done");
      status.textContent = fields.statusText || msg.done || "完成";
      head.append(name, status);
      row.appendChild(head);
      if (fields.task) {
        const task = document.createElement("div");
        task.className = "live-subagent-task";
        task.textContent = fields.task;
        row.appendChild(task);
      }
      if (fields.summary) {
        const summary = document.createElement("div");
        summary.className = "live-subagent-summary";
        summary.textContent = fields.summary;
        row.appendChild(summary);
      }
      panel.appendChild(row);
    }

    /**
     * @param {Map} subById
     * @param {Map} toolById
     * @param {Map} commandByKey
     * @param {{ open?: boolean, live?: boolean, emptyFallback?: boolean, events?: Array }} options
     * @returns {HTMLElement|null}
     */
    function renderProcessPanel(subById, toolById, commandByKey, options = {}) {
      const empty = isProcessBucketsEmpty({ subById, toolById, commandByKey });
      if (empty) {
        if (!options.emptyFallback) return null;
        return renderEmptyProcessState(options.events || []);
      }

      const panel = document.createElement("div");
      panel.className = "live-subagents live-subagents-final";

      // subById is unused (protocol no longer emits subagent.*); tools include task-like tools.
      void subById;

      for (const [id, evt] of toolById.entries()) {
        const detail = toolDetailFromEvent(evt);
        const failed = evt.status === "error";
        const done = evt.type === "tool.finished" || evt.result != null || evt.output != null;
        appendTraceRow(panel, {
          name: evt.toolName || "tool",
          status: failed ? "error" : done ? "done" : "running",
          statusText: failed
            ? msg.failed || "失败"
            : done
              ? msg.done || "完成"
              : msg.running || "运行中",
          task: detail,
          summary: failed ? processSummaryFromEvent(evt) : "",
          traceKind: evt._traceKind || "tool",
          traceId: evt._traceId || id,
          eventNos: evt._eventNos,
        });
      }

      const toolDetails = new Set(
        [...toolById.values()].map((t) => toolDetailFromEvent(t)).filter(Boolean)
      );
      for (const [cmdKey, evt] of commandByKey.entries()) {
        if (toolDetails.has(evt.command)) continue;
        const failed = evt.exitCode !== undefined && evt.exitCode !== 0;
        appendTraceRow(panel, {
          name: "command",
          status: failed ? "error" : "done",
          statusText: failed ? msg.failed || "失败" : msg.done || "完成",
          task: truncateDisplay(evt.command, 120),
          summary: failed ? processSummaryFromEvent(evt) : "",
          traceKind: evt._traceKind || "command",
          traceId: evt._traceId || cmdKey,
          eventNos: evt._eventNos,
        });
      }

      if (!panel.childNodes.length) {
        if (!options.emptyFallback) return null;
        return renderEmptyProcessState(options.events || []);
      }
      const open = options.open === true;
      const live = options.live === true;
      return wrapProcessDetails(panel, { open, live });
    }

    function renderEmptyProcessState(events) {
      const wrap = document.createElement("div");
      wrap.className = "recall-process-empty";
      const label = document.createElement("div");
      label.className = "recall-process-empty-label";
      label.textContent = msg.noTools || "无工具调用";
      wrap.appendChild(label);
      const summary = textDeltaSummary(events, 200);
      if (summary) {
        const snip = document.createElement("div");
        snip.className = "recall-process-text-summary";
        snip.textContent = summary;
        wrap.appendChild(snip);
      }
      return wrap;
    }

    function fromBuckets(buckets, options = {}) {
      const b = buckets || { subById: new Map(), toolById: new Map(), commandByKey: new Map() };
      return renderProcessPanel(b.subById, b.toolById, b.commandByKey, options);
    }

    function fromEvents(events, options = {}) {
      const buckets = aggregateProcessBuckets(events);
      return fromBuckets(buckets, { ...options, events });
    }

    return {
      appendTraceRow,
      wrapProcessDetails,
      updateProcessDetailsLabel,
      countProcessSteps,
      renderProcessPanel,
      renderEmptyProcessState,
      fromBuckets,
      fromEvents,
      aggregateProcessBuckets,
    };
  }

  /**
   * Adjacent same-kind merge for thinking/text segments (mirrors durable strategy A).
   * @param {Array<{kind: string, text: string}>|null|undefined} segments
   * @param {"thinking"|"text"} kind
   * @param {string} text
   * @returns {Array<{kind: string, text: string}>}
   */
  function appendContentSegment(segments, kind, text) {
    const list = Array.isArray(segments) ? segments : [];
    const chunk = typeof text === "string" ? text : "";
    if (!chunk || (kind !== "thinking" && kind !== "text")) return list;
    const last = list[list.length - 1];
    if (last && last.kind === kind) {
      last.text += chunk;
      return list;
    }
    list.push({ kind, text: chunk });
    return list;
  }

  /** Join segment bodies for a kind (read-time full text). */
  function joinSegmentText(segments, kind) {
    if (!Array.isArray(segments) || !kind) return "";
    let out = "";
    for (const seg of segments) {
      if (seg && seg.kind === kind && typeof seg.text === "string") out += seg.text;
    }
    return out;
  }

  /**
   * Build interleaved content segments from durable or live events.
   * Adjacent same-kind deltas are merged; kind switches open a new segment.
   * @param {Array<object>} events
   * @returns {Array<{kind: "thinking"|"text", text: string}>}
   */
  function buildContentSegmentsFromEvents(events) {
    const segments = [];
    for (const evt of events || []) {
      if (!evt || typeof evt !== "object") continue;
      const type = evt.kind || evt.type || "";
      const payload =
        evt.payload && typeof evt.payload === "object" && !evt.type ? evt.payload : evt;
      const text =
        typeof payload.text === "string"
          ? payload.text
          : typeof payload.content === "string"
            ? payload.content
            : "";
      if (!text) continue;
      if (type === "thinking.delta" || type === "thinking.final" || type === "thinking") {
        appendContentSegment(segments, "thinking", text);
      } else if (type === "text.delta" || type === "text.final" || type === "text") {
        appendContentSegment(segments, "text", text);
      }
    }
    return segments;
  }

  function fallbackSegmentsFromItem(item) {
    const segments = [];
    if (item && Array.isArray(item.segments) && item.segments.length) {
      return item.segments.map((s) => ({ kind: s.kind, text: s.text || "" }));
    }
    if (item && item.thinkingText) {
      appendContentSegment(segments, "thinking", item.thinkingText);
    }
    if (item && item.rawText) {
      appendContentSegment(segments, "text", item.rawText);
    }
    return segments;
  }

  function createMessageView(deps) {
    const {
      messagesEl,
      emptyStateEl,
      spacerEl,
      state,
      runtimeStore,
      renderMd,
      writeClipboard,
      ClipboardItem,
      getClipboard,
      roleDisplayName,
      roleBadgeLabel,
      agentColorIndex,
      attachRecallToggle,
      fetchInvocationEvents,
      onRuntimeStatusChange,
      setStatus,
      getSessionController,
      loadWorktreeStatus,
      loadWorkspaceState,
      syncComposerControls,
      getSessionSlot,
      renderAgentTabs,
      getChatClient,
      promptEl,
    } = deps;

    const processHelpers = resolveProcessHelpers() || {};
    const {
      toolDetailFromEvent,
      processSummaryFromEvent,
      progressItemLabel,
      progressItemDone,
      findAgentCapabilities,
      shouldRenderThinking,
      shouldRenderTools,
    } = processHelpers;
    const markdownLite = resolveMarkdownLite() || {};
    const paintMarkdown =
      typeof markdownLite.paintMarkdown === "function" ? markdownLite.paintMarkdown : null;

    /**
     * Final markdown paint with length-based deferral.
     * Cancels any previous deferred job on the same content element.
     * @param {HTMLElement} contentEl
     * @param {string} text
     * @param {{ copyBtn?: HTMLElement|null, host?: object|null }} [opts]
     */
    function paintFinalMarkdown(contentEl, text, opts = {}) {
      if (!contentEl) return { cancel() {}, deferred: false, mode: "noop" };
      if (contentEl._mdPaintCancel) {
        try {
          contentEl._mdPaintCancel();
        } catch {
          /* ignore */
        }
        contentEl._mdPaintCancel = null;
      }
      const copyBtn = opts.copyBtn || null;
      const host = opts.host || null;
      const onHtml = (html) => {
        if (copyBtn && html) copyBtn.dataset.copyHtml = html;
      };

      if (typeof paintMarkdown === "function") {
        const job = paintMarkdown(contentEl, text, { onHtml });
        contentEl._mdPaintCancel = job && job.cancel ? job.cancel : null;
        if (host) host._mdPaintCancel = contentEl._mdPaintCancel;
        return job;
      }

      // Fallback when MarkdownLite.paintMarkdown is unavailable.
      const html = typeof renderMd === "function" ? renderMd(text || "") : String(text || "");
      contentEl.classList.remove("is-md-plain", "is-md-pending-highlight");
      contentEl.innerHTML = html;
      onHtml(html);
      return { cancel() {}, deferred: false, mode: "sync" };
    }

    function capabilitiesFor(agentId) {
      if (typeof findAgentCapabilities === "function") {
        return findAgentCapabilities(state.agents || [], agentId);
      }
      return { resume: true, thinking: true, tools: true };
    }
    const L = resolveMsgLocale();
    const msg = L.message || {};
    const badgeText = L.badge || {};
    // Shared renderer: same DOM path as recall panel (locale injected).
    const processPanel = createProcessPanelRenderer({ locale: L });
    const { wrapProcessDetails, updateProcessDetailsLabel, renderProcessPanel } = processPanel;

    function sessionRuntime(sessionId) {
      return runtimeStore.getOrCreate(sessionId || state.currentSessionId || "_pending");
    }

    function isViewingSession(sessionId) {
      const sid = sessionId || "_pending";
      return !state.currentSessionId || state.currentSessionId === sid;
    }

    // Stick-to-bottom: only auto-scroll while the user is near the end.
    // Streaming must not yank the viewport when they scroll up to read.
    let _stickToBottom = true;
    let _scrollRafId = null;
    let _scrollForcePending = false;
    let _scrollListening = false;

    function distanceFromBottom() {
      if (!messagesEl) return 0;
      return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
    }

    function isNearBottom(threshold = STICK_BOTTOM_PX) {
      return distanceFromBottom() <= threshold;
    }

    function bindScrollTracking() {
      if (!messagesEl || _scrollListening || typeof messagesEl.addEventListener !== "function") {
        return;
      }
      _scrollListening = true;
      messagesEl.addEventListener(
        "scroll",
        () => {
          _stickToBottom = isNearBottom();
        },
        { passive: true }
      );
    }

    /**
     * @param {boolean} [force=false] jump even if user scrolled away
     */
    function scrollDown(force = false) {
      if (!messagesEl) return;
      if (!force && !_stickToBottom) return;
      messagesEl.scrollTop = messagesEl.scrollHeight;
      _stickToBottom = true;
    }

    /**
     * Coalesce scroll into one rAF (stream + tool rows fire very frequently).
     * Pending force flags survive re-entrant schedule calls in the same frame.
     * @param {boolean} [force=false]
     */
    function scheduleScrollDown(force = false) {
      if (force) {
        _stickToBottom = true;
        _scrollForcePending = true;
      } else if (!_stickToBottom && !_scrollForcePending) {
        return;
      }
      if (_scrollRafId != null) return;
      _scrollRafId = requestAnimationFrame(() => {
        _scrollRafId = null;
        const forceNow = _scrollForcePending;
        _scrollForcePending = false;
        scrollDown(forceNow);
      });
    }

    bindScrollTracking();

    function ensureSpacer() {
      if (!messagesEl.contains(spacerEl)) messagesEl.appendChild(spacerEl);
    }

    function hideEmpty() {
      if (emptyStateEl && emptyStateEl.parentNode) emptyStateEl.remove();
    }

    function showEmpty() {
      ensureSpacer();
      if (emptyStateEl && !emptyStateEl.parentNode) {
        messagesEl.insertBefore(emptyStateEl, spacerEl);
      }
    }

    function copyToClipboard(text, btn, okText = "✓", failText = "Failed") {
      const orig = btn.textContent;
      const html = btn && btn.dataset && btn.dataset.copyHtml;
      const write = writeClipboard(
        {
          clipboard: typeof getClipboard === "function" ? getClipboard() : navigator.clipboard,
          ClipboardItem:
            ClipboardItem || (typeof window !== "undefined" ? window.ClipboardItem : undefined),
        },
        {
          text,
          html,
        }
      );
      return write
        .then(() => {
          btn.textContent = okText;
          btn.classList.add("copied");
        })
        .catch(() => {
          btn.textContent = failText;
        })
        .finally(() => {
          setTimeout(() => {
            btn.textContent = orig;
            btn.classList.remove("copied");
          }, 1200);
        });
    }

    function renderMessageUsage(wrapper, input) {
      if (!wrapper) return null;
      const previous = wrapper.querySelector(".msg-usage");
      const usage = normalizedUsage(input);
      if (usage.totalTokens <= 0) {
        if (previous) previous.remove();
        return null;
      }

      const details = previous || document.createElement("details");
      details.className = "msg-usage";
      details.setAttribute("aria-label", "本轮 Token 用量");
      details.replaceChildren();

      const summary = document.createElement("summary");
      summary.textContent = `本轮 · ${compactUsageTokens(usage.totalTokens)} tokens`;
      const breakdown = document.createElement("dl");
      breakdown.className = "msg-usage-breakdown";
      const rows = [
        ["输入", usage.inputTokens],
        ["输出", usage.outputTokens],
        ["缓存", usage.cachedInputTokens],
        ["推理", usage.reasoningTokens],
      ];
      for (const [label, value] of rows) {
        if (value <= 0) continue;
        const row = document.createElement("div");
        const term = document.createElement("dt");
        const amount = document.createElement("dd");
        term.textContent = label;
        amount.textContent = compactUsageTokens(value);
        row.append(term, amount);
        breakdown.appendChild(row);
      }
      if (usage.costUsd > 0) {
        const row = document.createElement("div");
        const term = document.createElement("dt");
        const amount = document.createElement("dd");
        term.textContent = "费用";
        amount.textContent = `$${usage.costUsd.toFixed(4)}`;
        row.append(term, amount);
        breakdown.appendChild(row);
      }
      details.append(summary, breakdown);
      if (!previous) wrapper.appendChild(details);
      return details;
    }

    function makeSetBadge(badgeEl, wrapper) {
      return function setBadge(badgeState) {
        if (wrapper && wrapper.dataset) {
          if (badgeState) wrapper.dataset.agentStatus = badgeState;
          else delete wrapper.dataset.agentStatus;
        }
        if (!badgeState) {
          badgeEl.style.display = "none";
          badgeEl.className = "msg-badge";
          return;
        }
        badgeEl.style.display = "";
        const configs = {
          thinking: { cls: "badge-thinking", text: badgeText.thinking || "思考中", dot: true },
          writing: { cls: "badge-writing", text: badgeText.writing || "输出中", dot: true },
          done: { cls: "badge-done", text: "", dot: false },
          error: { cls: "badge-error", text: badgeText.error || "异常退出", dot: false },
        };
        const cfg = configs[badgeState] || configs.thinking;
        badgeEl.className = "msg-badge " + cfg.cls;
        badgeEl.innerHTML = cfg.dot ? `<span class="badge-dot"></span>${cfg.text}` : cfg.text;
      };
    }

    function createMessage({
      role,
      agent,
      content = "",
      variant = "",
      invocationId = null,
      usage = null,
      showUsage = true,
      scroll = true,
      kind = "",
      messageType = "",
      from = null,
      to = null,
      handoffId = null,
      routeStatus = null,
    }) {
      hideEmpty();
      ensureSpacer();

      const helpers = resolveProcessHelpers();
      const resolvedKind =
        messageType ||
        kind ||
        (helpers && typeof helpers.resolveMessageKind === "function"
          ? helpers.resolveMessageKind({
              role,
              content,
              kind,
              messageType,
            })
          : "") ||
        "";

      const wrapper = document.createElement("article");
      wrapper.className = ["message", role, variant].filter(Boolean).join(" ");
      if (resolvedKind) {
        wrapper.dataset.msgKind = resolvedKind;
        wrapper.classList.add(`kind-${resolvedKind}`);
      }
      if (role === "assistant" && agent && typeof agentColorIndex === "function") {
        wrapper.dataset.agentColor = String(agentColorIndex(agent));
        wrapper.dataset.agentId = String(agent);
      }
      if (role === "assistant") {
        wrapper.dataset.usageEligible = showUsage === false ? "false" : "true";
      }
      if (invocationId) wrapper.dataset.invocationId = String(invocationId);

      const meta = document.createElement("div");
      meta.className = "msg-meta";
      const metaLabel = document.createElement("span");
      metaLabel.className = "msg-name";
      metaLabel.textContent = roleDisplayName(role, agent);
      meta.appendChild(metaLabel);
      const metaRole = document.createElement("span");
      metaRole.className = "msg-role-label";
      metaRole.textContent = roleBadgeLabel(role);
      meta.appendChild(metaRole);
      if (role === "assistant" && agent) {
        const metaAgent = document.createElement("span");
        metaAgent.className = "msg-agent-id";
        metaAgent.textContent = agent;
        meta.appendChild(metaAgent);
      }
      if (role === "assistant" && invocationId) {
        const metaInv = document.createElement("span");
        metaInv.className = "msg-invocation-id";
        metaInv.title = String(invocationId);
        metaInv.textContent = `inv …${String(invocationId).slice(-8)}`;
        meta.appendChild(metaInv);
      }

      const badge = document.createElement("span");
      badge.className = "msg-badge";
      badge.style.display = "none";
      meta.appendChild(badge);

      let copyBtn = null;
      if (role === "assistant" && content) {
        copyBtn = document.createElement("button");
        copyBtn.className = "msg-copy";
        copyBtn.textContent = "⎘";
        copyBtn.title = msg.copy || "复制消息";
        copyBtn.setAttribute("aria-label", msg.copy || "复制消息");
        copyBtn.addEventListener("click", () => {
          copyToClipboard(content, copyBtn, "✓", msg.copyFail || "失败");
        });
        meta.appendChild(copyBtn);
      }

      const card = document.createElement("div");
      card.className = "msg-card";
      const bubble = document.createElement("div");
      bubble.className = "msg-bubble";
      card.appendChild(bubble);

      let avatar = null;
      if (globalScope.AgentAvatar) {
        if (role === "assistant" && agent) {
          avatar = globalScope.AgentAvatar.createAgentAvatar(agent, {
            label: roleDisplayName(role, agent),
            className: "agent-avatar-message",
          });
        } else if (role === "user" && typeof globalScope.AgentAvatar.createUserAvatar === "function") {
          avatar = globalScope.AgentAvatar.createUserAvatar({
            label: roleDisplayName(role, agent),
            className: "user-avatar-message",
          });
        }
      }
      if (avatar) wrapper.classList.add("has-avatar");

      if (role === "assistant" && content === "") {
        bubble.classList.add("msg-bubble-live");
        bubble.classList.add("msg-bubble-live-pending");
        const liveText = document.createElement("div");
        liveText.className = "stream-live-text";
        bubble.append(liveText);
        wrapper.append(...(avatar ? [avatar, meta, card] : [meta, card]));
        messagesEl.insertBefore(wrapper, spacerEl);
        if (scroll !== false) scheduleScrollDown(true);

        const setBadge = makeSetBadge(badge, wrapper);
        return {
          wrapper,
          bubble,
          meta,
          setBadge,
          _liveTextEl: liveText,
          thinkingText: "",
          segments: [],
          progressItems: [],
        };
      }

      const contentEl = document.createElement("div");
      contentEl.className = "msg-final-content";
      // Collab system notices: structured handoff / route cards instead of plain prose.
      if (
        role === "system" &&
        helpers &&
        typeof helpers.isCollabSystemKind === "function" &&
        helpers.isCollabSystemKind(resolvedKind)
      ) {
        bubble.classList.add("msg-bubble-handoff");
        contentEl.appendChild(
          buildHandoffCardEl({
            content,
            kind: resolvedKind,
            from,
            to,
            handoffId,
            routeStatus,
            helpers,
          })
        );
      } else {
        // Length-aware paint: short sync; long structure+idle Prism; super-long plain first.
        paintFinalMarkdown(contentEl, content, { copyBtn });
      }
      bubble.appendChild(contentEl);

      wrapper.append(...(avatar ? [avatar, meta, card] : [meta, card]));
      if (role === "assistant" && showUsage !== false) renderMessageUsage(wrapper, usage);
      messagesEl.insertBefore(wrapper, spacerEl);
      if (scroll !== false) scheduleScrollDown(true);

      if (role === "assistant" && invocationId) {
        if (typeof attachRecallToggle === "function") attachRecallToggle(wrapper, invocationId);
        scheduleHydrateProcessTrace(bubble, invocationId);
      }

      const setBadge = makeSetBadge(badge, wrapper);
      return { wrapper, bubble, meta, setBadge, contentEl };
    }

    function buildHandoffCardEl({ content, kind, from, to, handoffId, routeStatus, helpers }) {
      const cardEl = document.createElement("div");
      cardEl.className = "handoff-card";
      if (kind) cardEl.dataset.kind = kind;

      const parsed =
        helpers && typeof helpers.parseA2aRouteContent === "function"
          ? helpers.parseA2aRouteContent(content)
          : null;
      const fromLabel = from || parsed?.fromLabel || "?";
      const toLabel = to || parsed?.toLabel || "?";
      const skipped =
        kind === "a2a-skipped" || kind === "handoff-repair-needed" || parsed?.skipped;
      const degraded = parsed?.degraded || routeStatus === "allow_degraded";

      const title = document.createElement("div");
      title.className = "handoff-card-title";
      title.textContent = skipped ? "协作未入队" : degraded ? "交接（降级）" : "协作交接";
      cardEl.appendChild(title);

      const route = document.createElement("div");
      route.className = "handoff-card-route";
      const fromPill = document.createElement("span");
      fromPill.className = "handoff-pill from";
      fromPill.textContent = fromLabel;
      const arrow = document.createElement("span");
      arrow.className = "handoff-arrow";
      arrow.textContent = "→";
      const toPill = document.createElement("span");
      toPill.className = "handoff-pill to";
      toPill.textContent = toLabel;
      route.append(fromPill, arrow, toPill);
      cardEl.appendChild(route);

      const metaRow = document.createElement("div");
      metaRow.className = "handoff-card-meta";
      if (kind) {
        const k = document.createElement("span");
        k.className = "handoff-meta-chip";
        k.textContent = kind;
        metaRow.appendChild(k);
      }
      if (routeStatus) {
        const s = document.createElement("span");
        s.className = "handoff-meta-chip";
        s.textContent = routeStatus;
        metaRow.appendChild(s);
      }
      if (handoffId) {
        const h = document.createElement("span");
        h.className = "handoff-meta-chip mono";
        h.title = handoffId;
        h.textContent = `id …${String(handoffId).slice(-8)}`;
        metaRow.appendChild(h);
      }
      if (metaRow.childNodes.length) cardEl.appendChild(metaRow);

      const body = document.createElement("div");
      body.className = "handoff-card-body";
      body.textContent = String(content || "").trim();
      cardEl.appendChild(body);
      return cardEl;
    }

    /**
     * Collapse prior multi-agent turns in each user segment; keep final assistant expanded.
     * Call after bulk history insert or live route bursts.
     */
    function organizeCollabMessages(options = {}) {
      if (!messagesEl) return;
      const openLast = options.openLast !== false;
      const children = Array.from(messagesEl.children).filter(
        (el) => el.classList && el.classList.contains("message")
      );
      // Unwrap previous groups so re-run is idempotent
      for (const group of Array.from(messagesEl.querySelectorAll(":scope > .collab-group"))) {
        const parent = group.parentNode;
        while (group.firstChild) parent.insertBefore(group.firstChild, group);
        group.remove();
      }

      let segment = [];
      const flush = () => {
        if (segment.length === 0) return;
        organizeCollabSegment(segment, { openLast });
        segment = [];
      };
      for (const el of children) {
        if (el.classList.contains("user")) {
          flush();
          segment = [el];
        } else {
          segment.push(el);
        }
      }
      flush();
    }

    function organizeCollabSegment(segment, { openLast }) {
      if (!segment || segment.length < 3) return;
      // Need user + at least two assistant (or assistant + routes + assistant)
      const assistants = segment.filter((el) => el.classList.contains("assistant"));
      if (assistants.length < 2) return;
      const lastAssistant = assistants[assistants.length - 1];
      const lastIdx = segment.indexOf(lastAssistant);
      if (lastIdx <= 1) return;
      const prior = segment.slice(1, lastIdx);
      if (prior.length === 0) return;

      const details = document.createElement("details");
      details.className = "collab-group";
      details.open = false;
      const summary = document.createElement("summary");
      summary.className = "collab-group-summary";
      const agentIds = prior
        .filter((el) => el.classList.contains("assistant") && el.dataset.agentId)
        .map((el) => el.dataset.agentId);
      const uniqueAgents = [...new Set(agentIds)];
      const routeCount = prior.filter(
        (el) => el.dataset.msgKind === "a2a-route" || el.classList.contains("kind-a2a-route")
      ).length;
      summary.textContent =
        `协作过程 · ${prior.length} 条` +
        (uniqueAgents.length ? ` · ${uniqueAgents.join(" → ")}` : "") +
        (routeCount ? ` · ${routeCount} 次交接` : "") +
        (openLast ? "（最终回答已展开）" : "");
      details.appendChild(summary);
      const body = document.createElement("div");
      body.className = "collab-group-body";
      details.appendChild(body);

      const insertBeforeEl = prior[0];
      insertBeforeEl.parentNode.insertBefore(details, insertBeforeEl);
      for (const el of prior) {
        body.appendChild(el);
      }
    }

    function thinkingSummaryLabel(text) {
      const chars = (text || "").length;
      const base = msg.thinkingProcess || "思考过程";
      if (chars <= 0) return base;
      return typeof msg.thinkingProcessChars === "function"
        ? msg.thinkingProcessChars(chars)
        : `${base} · ${chars} 字`;
    }

    function createThinkingSegmentEl(text, options = {}) {
      const details = document.createElement("details");
      details.className = "msg-thinking";
      details.dataset.segKind = "thinking";
      details.open = options.open === true;
      if (options.live) details.dataset.live = "true";
      else details.removeAttribute("data-live");
      const summary = document.createElement("summary");
      summary.className = "msg-thinking-summary";
      summary.textContent = thinkingSummaryLabel(text);
      const body = document.createElement("pre");
      body.className = "msg-thinking-body";
      body.textContent = text || "";
      details.append(summary, body);
      return details;
    }

    function updateThinkingSegmentEl(details, text, options = {}) {
      if (!details) return;
      if (options.live) details.dataset.live = "true";
      else details.removeAttribute("data-live");
      if (options.open === true) details.open = true;
      if (options.open === false) details.open = false;
      const body = details.querySelector(".msg-thinking-body");
      if (body) body.textContent = text || "";
      const summary = details.querySelector(".msg-thinking-summary");
      if (summary) summary.textContent = thinkingSummaryLabel(text);
    }

    /**
     * Ensure the interleaved stream container exists. Progress / process panels
     * stay outside so tools do not break the think↔text timeline.
     */
    function ensureStreamRoot(liveItem) {
      if (!liveItem || !liveItem.bubble) return null;
      let root = liveItem.bubble.querySelector(":scope > .msg-stream-segments");
      if (root) return root;
      root = document.createElement("div");
      root.className = "msg-stream-segments";
      const process =
        liveItem.bubble.querySelector(":scope > .msg-process") ||
        liveItem.bubble.querySelector(":scope > .live-subagents");
      const progress =
        liveItem.bubble.querySelector(":scope > .msg-progress") ||
        liveItem.bubble.querySelector(":scope > .msg-progress-wrap");
      const status = liveItem.bubble.querySelector(":scope > .live-process-status");
      const anchor = process || status || null;
      if (anchor) liveItem.bubble.insertBefore(root, anchor);
      else if (progress && progress.nextSibling) {
        liveItem.bubble.insertBefore(root, progress.nextSibling);
      } else if (progress) {
        progress.after(root);
      } else {
        liveItem.bubble.appendChild(root);
      }
      return root;
    }

    /**
     * Paint thinking/text segments in timeline order (adjacent same-kind merged).
     * @param {object} liveItem
     * @param {{ live?: boolean, markdown?: boolean, copyBtn?: HTMLElement }} [options]
     */
    function paintStreamSegments(liveItem, options = {}) {
      if (!liveItem || !liveItem.bubble) return;
      const live = options.live !== false;
      const useMarkdown = options.markdown === true || live === false;
      const segments = Array.isArray(liveItem.segments) ? liveItem.segments : [];
      if (segments.length === 0) {
        liveItem.thinkingText = "";
        liveItem.rawText = liveItem.rawText || "";
        return;
      }
      const root = ensureStreamRoot(liveItem);
      if (!root) return;

      // Drop the bootstrap single live-text node once the stream root owns text.
      if (
        liveItem._liveTextEl &&
        liveItem._liveTextEl.parentNode === liveItem.bubble &&
        segments.length > 0
      ) {
        liveItem._liveTextEl.remove();
      }

      while (root.children.length > segments.length) {
        root.removeChild(root.lastChild);
      }

      let lastTextEl = null;
      for (let i = 0; i < segments.length; i += 1) {
        const seg = segments[i];
        const kind = seg && seg.kind === "thinking" ? "thinking" : "text";
        const text = (seg && seg.text) || "";
        let el = root.children[i] || null;

        if (kind === "thinking") {
          if (!el || el.dataset.segKind !== "thinking") {
            const next = createThinkingSegmentEl(text, {
              live,
              open: false,
            });
            if (el) root.replaceChild(next, el);
            else root.appendChild(next);
            el = next;
          } else {
            updateThinkingSegmentEl(el, text, { live, open: false });
          }
        } else if (live && !useMarkdown) {
          if (!el || el.dataset.segKind !== "text" || !el.classList.contains("stream-live-text")) {
            const next = document.createElement("div");
            next.className = "stream-live-text";
            next.dataset.segKind = "text";
            next.textContent = text;
            if (el) root.replaceChild(next, el);
            else root.appendChild(next);
            el = next;
          } else {
            el.textContent = text;
          }
          lastTextEl = el;
        } else {
          if (!el || el.dataset.segKind !== "text" || !el.classList.contains("msg-final-content")) {
            const next = document.createElement("div");
            next.className = "msg-final-content";
            next.dataset.segKind = "text";
            next.dataset.segText = text;
            if (el) root.replaceChild(next, el);
            else root.appendChild(next);
            el = next;
            paintFinalMarkdown(el, text, { copyBtn: options.copyBtn, host: liveItem });
          } else if (el.dataset.segText !== text) {
            el.dataset.segText = text;
            paintFinalMarkdown(el, text, { copyBtn: options.copyBtn, host: liveItem });
          }
          lastTextEl = el;
        }
      }

      liveItem._liveTextEl = lastTextEl;
      liveItem.thinkingText = joinSegmentText(segments, "thinking");
      liveItem.rawText = joinSegmentText(segments, "text");
    }

    let _streamRafId = null;
    /** @type {Map<string, object>} key → liveItem */
    let _streamPending = new Map();

    function _flushStreamRaf() {
      for (const item of _streamPending.values()) {
        if (item && item.bubble) paintStreamSegments(item, { live: true, markdown: false });
      }
      _streamPending.clear();
      _streamRafId = null;
      scheduleScrollDown();
    }

    function flushPendingThinkingRender() {
      if (_streamRafId != null) {
        cancelAnimationFrame(_streamRafId);
        _streamRafId = null;
        _flushStreamRaf();
      }
    }

    /**
     * Schedule (or immediately paint) interleaved stream segments for a live item.
     * @param {object} liveItem
     * @param {{ immediate?: boolean, key?: string }} [options]
     */
    function scheduleStreamPaint(liveItem, options = {}) {
      if (!liveItem || !liveItem.bubble) return;
      if (options.immediate === true) {
        paintStreamSegments(liveItem, { live: true, markdown: false });
        return;
      }
      const key =
        options.key ||
        (liveItem.wrapper && liveItem.wrapper.dataset && liveItem.wrapper.dataset.agentId) ||
        String((liveItem.segments && liveItem.segments.length) || 0);
      _streamPending.set(key, liveItem);
      if (_streamRafId == null) {
        _streamRafId = requestAnimationFrame(_flushStreamRaf);
      }
    }

    /**
     * Legacy helper: set cumulative thinking text as a single segment prefix.
     * Prefer appendLiveSegment for timeline fidelity.
     */
    function updateThinkingPanel(liveItem, text, options = {}) {
      if (!liveItem || !text) return;
      liveItem.thinkingText = text;
      if (!Array.isArray(liveItem.segments)) liveItem.segments = [];
      // Rebuild: keep text segments, replace thinking as leading blocks is wrong.
      // If segments empty, just one thinking segment; else if only text, prepend thinking once.
      if (liveItem.segments.length === 0) {
        liveItem.segments = [{ kind: "thinking", text }];
      } else if (liveItem.segments.every((s) => s.kind === "text")) {
        liveItem.segments = [{ kind: "thinking", text }, ...liveItem.segments];
      } else {
        // Update last thinking segment or first if present
        let found = false;
        for (let i = liveItem.segments.length - 1; i >= 0; i -= 1) {
          if (liveItem.segments[i].kind === "thinking") {
            liveItem.segments[i].text = text;
            found = true;
            break;
          }
        }
        if (!found) appendContentSegment(liveItem.segments, "thinking", text);
      }
      scheduleStreamPaint(liveItem, options);
    }

    function ensureProgressList(liveItem) {
      if (!liveItem || !liveItem.bubble) return null;
      let list = liveItem.bubble.querySelector(":scope > .msg-progress");
      if (list) return list;
      list = document.createElement("ul");
      list.className = "msg-progress";
      const stream = liveItem.bubble.querySelector(":scope > .msg-stream-segments");
      if (stream) {
        liveItem.bubble.insertBefore(list, stream);
      } else if (liveItem._liveTextEl && liveItem._liveTextEl.parentNode === liveItem.bubble) {
        liveItem.bubble.insertBefore(list, liveItem._liveTextEl);
      } else {
        liveItem.bubble.insertBefore(list, liveItem.bubble.firstChild);
      }
      return list;
    }

    function updateProgressList(liveItem, items) {
      if (!liveItem) return;
      const listItems = Array.isArray(items) ? items : [];
      liveItem.progressItems = listItems;
      if (!liveItem.bubble || listItems.length === 0) {
        const existing = liveItem.bubble && liveItem.bubble.querySelector(".msg-progress");
        if (existing && listItems.length === 0) existing.remove();
        return;
      }
      const list = ensureProgressList(liveItem);
      if (!list) return;
      list.replaceChildren(
        ...listItems.map((item, index) => {
          const li = document.createElement("li");
          const done = progressItemDone(item);
          const active = !done && listItems.findIndex((x) => !progressItemDone(x)) === index;
          li.className = done ? "is-done" : active ? "is-active" : "is-pending";
          li.textContent = progressItemLabel(item) || "(step)";
          return li;
        })
      );
    }

    function showThinking(agent, sessionId) {
      const sid = sessionId || state.currentSessionId || "_pending";
      const rt = sessionRuntime(sid);
      if (rt.liveMessages.has(agent)) return;

      if (!isViewingSession(sid)) {
        rt.liveMessages.set(agent, {
          rawText: "",
          thinkingText: "",
          segments: [],
          invocationId: rt.liveInvocations.get(agent) || null,
          detached: true,
          setBadge() {},
        });
        return;
      }

      const item = createMessage({ role: "assistant", agent, content: "" });
      item.setBadge("thinking");
      item.rawText = "";
      item.thinkingText = "";
      item.segments = [];
      item.invocationId = rt.liveInvocations.get(agent) || null;
      rt.liveMessages.set(agent, item);
    }

    function stopThinking(agent, sessionId) {
      const rt = sessionRuntime(sessionId);
      const item = rt.liveMessages.get(agent);
      if (!item) return;
      item.setBadge("done");
    }

    function trimLiveStatus(text, max = 140) {
      const singleLine = String(text || "")
        .replace(/\s+/g, " ")
        .trim();
      if (!singleLine) return "";
      return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine;
    }

    function pendingTextForEvent(event) {
      if (!event || !event.type) return "";

      if (event.type === "run.started") return "正在执行…";
      if (event.type === "run.failed") return trimLiveStatus(event.error || "执行失败");
      if (event.type === "file.changed") return `修改文件: ${trimLiveStatus(event.path || "")}`;
      if (event.type === "stderr") return trimLiveStatus(event.text || "");
      if (event.type === "tool.started") {
        const args = event.args && typeof event.args === "object" ? event.args : {};
        const detail =
          args.path ||
          args.file ||
          args.filePath ||
          args.file_path ||
          args.pattern ||
          args.command ||
          args.cmd ||
          "";
        const label = detail ? `${event.toolName || "tool"} ${detail}` : event.toolName || "tool";
        return `工具: ${trimLiveStatus(label)}`;
      }
      if (event.type === "tool.finished") {
        const status = event.status === "error" ? "失败" : "完成";
        const args = event.args && typeof event.args === "object" ? event.args : {};
        const detail =
          args.path ||
          args.file ||
          args.filePath ||
          args.file_path ||
          args.pattern ||
          args.command ||
          args.cmd ||
          "";
        const label = detail ? `${event.toolName || "tool"} ${detail}` : event.toolName || "tool";
        return `工具${status}: ${trimLiveStatus(label)}`;
      }
      if (event.type === "progress.update") {
        const items = Array.isArray(event.items) ? event.items : [];
        const active = items.find((item) => item && item.done !== true) || items[items.length - 1];
        return active && active.text ? `进度: ${trimLiveStatus(active.text)}` : "";
      }
      return "";
    }

    function ensureSubagentPanel(liveItem) {
      if (!liveItem || !liveItem.bubble) return null;
      let details = liveItem.bubble.querySelector(".msg-process");
      let panel = details
        ? details.querySelector(".live-subagents")
        : liveItem.bubble.querySelector(".live-subagents");
      if (panel) {
        if (!details) {
          wrapProcessDetails(panel, { open: true, live: true });
        }
        return panel;
      }

      panel = document.createElement("div");
      panel.className = "live-subagents";
      details = document.createElement("details");
      details.className = "msg-process";
      details.open = true;
      details.dataset.live = "true";
      const summary = document.createElement("summary");
      summary.className = "msg-process-summary";
      summary.textContent = msg.process || "执行过程";
      details.append(summary, panel);

      const stream = liveItem.bubble.querySelector(":scope > .msg-stream-segments");
      if (stream) {
        // Tools stay outside the think↔text timeline container.
        stream.after(details);
      } else if (liveItem._liveTextEl && liveItem._liveTextEl.parentNode === liveItem.bubble) {
        liveItem.bubble.insertBefore(details, liveItem._liveTextEl);
      } else {
        const content = liveItem.bubble.querySelector(".msg-final-content");
        if (content) liveItem.bubble.insertBefore(details, content);
        else liveItem.bubble.appendChild(details);
      }
      return panel;
    }

    function ensureProcessPanel(liveItem) {
      return ensureSubagentPanel(liveItem);
    }

    function upsertProcessRow(agent, key, fields, sessionId) {
      const sid = sessionId || state.currentSessionId || "_pending";
      if (!isViewingSession(sid)) return;
      const rt = sessionRuntime(sid);
      if (!rt.liveMessages.has(agent)) showThinking(agent, sid);
      const liveItem = rt.liveMessages.get(agent);
      if (!liveItem || liveItem.detached || !liveItem.bubble) return;

      const panel = ensureProcessPanel(liveItem);
      if (!panel) return;

      const id = String(key || "process");
      let row = null;
      for (const child of panel.children) {
        if (child && child.dataset && child.dataset.processId === id) {
          row = child;
          break;
        }
      }
      if (!row) {
        row = document.createElement("div");
        row.className = "live-subagent live-tool-row";
        row.dataset.processId = id;
        row.innerHTML = `
          <div class="live-subagent-head">
            <span class="live-subagent-name"></span>
            <span class="live-subagent-status"></span>
          </div>
          <div class="live-subagent-task"></div>
          <div class="live-subagent-summary"></div>`;
        panel.appendChild(row);
      }

      const nameEl = row.querySelector(".live-subagent-name");
      const statusEl = row.querySelector(".live-subagent-status");
      const taskEl = row.querySelector(".live-subagent-task");
      const summaryEl = row.querySelector(".live-subagent-summary");

      nameEl.textContent = fields.name || "tool";
      const status = fields.status || "running";
      statusEl.textContent = fields.statusText || msg.running || "运行中";
      statusEl.className = `live-subagent-status status-${status}`;
      row.className = `live-subagent live-tool-row status-${status}`;
      taskEl.textContent = fields.task || "";
      summaryEl.textContent = fields.summary || "";
      const details = panel.closest && panel.closest(".msg-process");
      if (details) updateProcessDetailsLabel(details);
      scheduleScrollDown();
    }

    function upsertLiveTool(agent, event, sessionId) {
      const detail = toolDetailFromEvent(event);
      const id = `tool:${event.toolId || event.toolName || detail || event.type}`;
      let status = "running";
      let statusText = msg.running || "运行中";
      if (event.type === "tool.finished") {
        const failed =
          event.status === "error" || (event.exitCode !== undefined && event.exitCode !== 0);
        status = failed ? "error" : "done";
        statusText = failed ? msg.failed || "失败" : msg.done || "完成";
      }
      const name = event.toolName || "tool";
      upsertProcessRow(
        agent,
        id,
        {
          name,
          status,
          statusText,
          task: detail || event.toolName || "",
          summary: processSummaryFromEvent(event),
        },
        sessionId
      );
    }

    function setLivePending(agent, text, sessionId) {
      if (!text) return;
      const sid = sessionId || state.currentSessionId || "_pending";
      const rt = sessionRuntime(sid);
      if (!rt.liveMessages.has(agent)) showThinking(agent, sid);
      const item = rt.liveMessages.get(agent);
      if (!item) return;
      item.pendingStatus = text;
      if (!isViewingSession(sid)) return;
      if (item._liveTextEl && !item.rawText) {
        item._liveTextEl.textContent = text;
        scheduleScrollDown();
        return;
      }
      if (item.bubble) {
        let statusEl = item.bubble.querySelector(".live-process-status");
        if (!statusEl) {
          statusEl = document.createElement("div");
          statusEl.className = "live-process-status";
          if (item._liveTextEl && item._liveTextEl.parentNode === item.bubble) {
            item.bubble.insertBefore(statusEl, item._liveTextEl);
          } else {
            item.bubble.appendChild(statusEl);
          }
        }
        statusEl.textContent = text;
        scheduleScrollDown();
      }
    }

    function flushPendingLiveRender(sessionId) {
      flushPendingThinkingRender();
      void sessionId;
    }

    /**
     * Ensure a live message item exists (viewing DOM or detached buffer).
     */
    function ensureLiveItem(agent, sessionId, options = {}) {
      const sid = sessionId || state.currentSessionId || "_pending";
      const rt = sessionRuntime(sid);
      const viewing = isViewingSession(sid);
      const existing = rt.liveMessages.get(agent);
      if (existing && !existing.detached) return existing;

      if (!viewing) {
        const prev = existing;
        const item = {
          rawText: (prev && prev.rawText) || "",
          thinkingText: (prev && prev.thinkingText) || "",
          segments: Array.isArray(prev && prev.segments)
            ? prev.segments.map((s) => ({ kind: s.kind, text: s.text || "" }))
            : [],
          invocationId: (prev && prev.invocationId) || rt.liveInvocations.get(agent) || null,
          detached: true,
          setBadge() {},
        };
        rt.liveMessages.set(agent, item);
        return item;
      }

      const item = createMessage({ role: "assistant", agent });
      const prev = existing;
      item.rawText = (prev && prev.rawText) || "";
      item.thinkingText = (prev && prev.thinkingText) || "";
      item.segments = Array.isArray(prev && prev.segments)
        ? prev.segments.map((s) => ({ kind: s.kind, text: s.text || "" }))
        : [];
      item.invocationId =
        (prev && prev.invocationId) || rt.liveInvocations.get(agent) || null;
      if (options.badge && item.setBadge) item.setBadge(options.badge);
      rt.liveMessages.set(agent, item);
      return item;
    }

    /**
     * Append a thinking or text streak fragment; merges adjacent same-kind.
     * Live SSE may be fine-grained — display still coalesces visually.
     */
    function appendLiveSegment(agent, kind, text, sessionId) {
      const chunk = typeof text === "string" ? text : "";
      if (!chunk || (kind !== "thinking" && kind !== "text")) return;
      const sid = sessionId || state.currentSessionId || "_pending";
      const viewing = isViewingSession(sid);
      const item = ensureLiveItem(agent, sid, {
        badge: kind === "text" ? "writing" : "thinking",
      });
      if (!Array.isArray(item.segments)) item.segments = [];
      appendContentSegment(item.segments, kind, chunk);
      item.rawText = joinSegmentText(item.segments, "text");
      item.thinkingText = joinSegmentText(item.segments, "thinking");

      if (!viewing) return;

      hideEmpty();
      ensureSpacer();
      if (item.bubble) item.bubble.classList.remove("msg-bubble-live-pending");
      if (item.setBadge) item.setBadge(kind === "text" ? "writing" : "thinking");
      scheduleStreamPaint(item, { key: `${sid}::${agent}` });
    }

    function appendLive(agent, text, sessionId) {
      appendLiveSegment(agent, "text", text, sessionId);
    }

    function ensureLiveRun(event, sessionId) {
      const rt = sessionRuntime(sessionId);
      const invocationId =
        event && event.invocationId
          ? event.invocationId
          : rt.liveInvocations.get(event.agent) || event.agent;
      if (!rt.liveRuns.has(invocationId)) {
        rt.liveRuns.set(invocationId, {
          invocationId,
          agent: event.agent,
          text: "",
          thinking: "",
          segments: [],
          progressItems: [],
          tools: [],
          diagnostics: [],
          fileChanges: [],
          stderr: [],
          usage: null,
          status: "thinking",
        });
      }
      return rt.liveRuns.get(invocationId);
    }

    function applyAgentEvent(event, sessionId) {
      if (!event || !event.type || !event.agent) return;
      const sid = sessionId || state.currentSessionId || "_pending";
      const run = ensureLiveRun(event, sid);
      const caps = capabilitiesFor(event.agent);

      if (event.type === "run.started") {
        run.status = "thinking";
        setLivePending(event.agent, pendingTextForEvent(event), sid);
        return;
      }

      if (event.type === "text.delta") {
        const chunk = event.text || "";
        run.text += chunk;
        if (!Array.isArray(run.segments)) run.segments = [];
        appendContentSegment(run.segments, "text", chunk);
        run.status = "writing";
        appendLiveSegment(event.agent, "text", chunk, sid);
        return;
      }

      if (event.type === "thinking.delta") {
        // Capability-driven: still record text for run state, but skip thinking UI
        // when the provider does not advertise thinking streams.
        const chunk = event.text || "";
        run.thinking += chunk;
        if (!Array.isArray(run.segments)) run.segments = [];
        appendContentSegment(run.segments, "thinking", chunk);
        if (typeof shouldRenderThinking === "function" && !shouldRenderThinking(caps)) {
          return;
        }
        appendLiveSegment(event.agent, "thinking", chunk, sid);
        return;
      }

      if (event.type === "progress.update") {
        run.progressItems = Array.isArray(event.items) ? event.items : [];
        setLivePending(event.agent, pendingTextForEvent(event), sid);
        const rt = sessionRuntime(sid);
        if (!rt.liveMessages.has(event.agent)) showThinking(event.agent, sid);
        const item = rt.liveMessages.get(event.agent);
        if (item && isViewingSession(sid)) {
          updateProgressList(item, run.progressItems);
        } else if (item) {
          item.progressItems = run.progressItems;
        }
        return;
      }

      if (event.type === "usage.update") {
        run.usage = { ...event };
        return;
      }

      if (event.type === "tool.started" || event.type === "tool.finished") {
        run.tools.push(event);
        setLivePending(event.agent, pendingTextForEvent(event), sid);
        if (typeof shouldRenderTools === "function" && !shouldRenderTools(caps)) {
          return;
        }
        upsertLiveTool(event.agent, event, sid);
        return;
      }

      // Legacy transcript kinds (subagent.* / command.*) fold into tool UI.
      if (
        event.type === "subagent.started" ||
        event.type === "subagent.progress" ||
        event.type === "subagent.completed" ||
        event.type === "subagent.failed"
      ) {
        const folded = {
          type:
            event.type === "subagent.completed" || event.type === "subagent.failed"
              ? "tool.finished"
              : "tool.started",
          agent: event.agent,
          invocationId: event.invocationId,
          toolName: event.toolName || event.name || "task",
          toolId: event.subagentId || event.toolId || "legacy-task",
          args: event.args || { task: event.task },
          result: event.summary || event.error || event.text,
          status: event.type === "subagent.failed" ? "error" : "ok",
        };
        run.tools.push(folded);
        setLivePending(event.agent, pendingTextForEvent(folded), sid);
        if (typeof shouldRenderTools === "function" && !shouldRenderTools(caps)) {
          return;
        }
        upsertLiveTool(event.agent, folded, sid);
        return;
      }

      if (event.type === "command.started" || event.type === "command.finished") {
        const folded = {
          type: event.type === "command.finished" ? "tool.finished" : "tool.started",
          agent: event.agent,
          invocationId: event.invocationId,
          toolName: "command_execution",
          toolId: event.command || "legacy-command",
          args: { command: event.command || "" },
          result: event.output,
          output: event.output,
          exitCode: event.exitCode,
          status:
            event.type === "command.finished" &&
            event.exitCode !== undefined &&
            event.exitCode !== 0
              ? "error"
              : "ok",
        };
        run.tools.push(folded);
        setLivePending(event.agent, pendingTextForEvent(folded), sid);
        if (typeof shouldRenderTools === "function" && !shouldRenderTools(caps)) {
          return;
        }
        upsertLiveTool(event.agent, folded, sid);
        return;
      }

      if (event.type === "diagnostic") {
        if (!Array.isArray(run.diagnostics)) run.diagnostics = [];
        run.diagnostics.push(event);
        if (event.visibility !== "hidden") {
          const count = Math.max(1, Number(event.count) || 1);
          upsertProcessRow(
            event.agent,
            `diagnostic:${event.fingerprint || event.code}`,
            {
              name: count > 1 ? `诊断 × ${count}` : "诊断",
              status: event.severity === "error" ? "error" : "done",
              statusText: event.severity === "error" ? msg.failed || "失败" : "提示",
              task: event.message || event.code || "",
              summary: "",
            },
            sid
          );
        }
        if (event.visibility === "inline" && event.severity === "error") {
          setLivePending(event.agent, event.message || "执行异常", sid);
        }
        return;
      }

      if (event.type === "file.changed") {
        run.fileChanges.push({
          path: event.path || "",
          changeType: event.changeType || "",
        });
        setLivePending(event.agent, pendingTextForEvent(event), sid);
        return;
      }

      if (event.type === "stderr") {
        run.stderr.push(event.text || "");
        setLivePending(event.agent, pendingTextForEvent(event), sid);
        return;
      }

      if (event.type === "run.finished") {
        run.status = event.exitCode === 0 ? "done" : "error";
        if (run.status === "error") sessionRuntime(sid).status = "error";
        return;
      }

      if (event.type === "run.failed") {
        run.status = "error";
        if (event.error) run.stderr.push(event.error);
        sessionRuntime(sid).status = "error";
      }
    }

    /**
     * Live final panel: flatten run tools/commands into the same
     * aggregateProcessBuckets path as history/recall (N1 / Phase B).
     */
    function buildProcessTraceFromRun(agent, sid) {
      const rt = sessionRuntime(sid);
      const flat = [];
      for (const run of rt.liveRuns.values()) {
        if (!run || run.agent !== agent) continue;
        for (const evt of run.tools || []) {
          if (evt) flat.push(evt);
        }
        for (const evt of run.diagnostics || []) {
          if (evt) flat.push(evt);
        }
      }
      const aggregate =
        typeof processHelpers.aggregateProcessBuckets === "function"
          ? processHelpers.aggregateProcessBuckets
          : processPanel.aggregateProcessBuckets;
      const buckets = aggregate(flat);
      return renderProcessPanel(buckets.subById, buckets.toolById, buckets.commandByKey);
    }

    /** History hydrate: same buckets + DOM path as recall (collapsed by default). */
    function buildProcessPanelFromTranscriptEvents(events, options = {}) {
      const stamped =
        typeof processHelpers.stampEventNos === "function"
          ? processHelpers.stampEventNos(events, options.from || 0)
          : events;
      return processPanel.fromEvents(stamped, { ...options, events: stamped });
    }

    /**
     * Open + scroll to an already-hydrated process panel on a message wrapper.
     * Used by Phase B "回忆" navigation anchor.
     */
    function focusProcessPanel(wrapper, options = {}) {
      if (!wrapper) return false;
      const process =
        wrapper.querySelector(".msg-process") || wrapper.querySelector(".live-subagents");
      if (!process) return false;
      if (process.tagName === "DETAILS" || process.classList.contains("msg-process")) {
        process.open = true;
      }
      process.classList.add("is-recall-focus");
      try {
        process.scrollIntoView({
          behavior: options.smooth === false ? "auto" : "smooth",
          block: "nearest",
        });
      } catch {
        /* ignore */
      }
      const clearMs = Number(options.clearMs) || 1600;
      setTimeout(() => process.classList.remove("is-recall-focus"), clearMs);
      return true;
    }

    /**
     * Replace a history bubble's single content block with L1 interleaved
     * thinking/text segments when durable events preserve the timeline.
     */
    function hydrateInterleavedContent(bubble, events, wrapper) {
      if (!bubble) return false;
      const segments = buildContentSegmentsFromEvents(events);
      const hasThinking = segments.some((s) => s && s.kind === "thinking" && s.text);
      if (!hasThinking || segments.length === 0) return false;

      const copy = wrapper && wrapper.querySelector ? wrapper.querySelector(".msg-copy") : null;
      // Remove flat history paint (single content / single thinking).
      bubble
        .querySelectorAll(
          ":scope > .msg-final-content, :scope > .msg-thinking, :scope > .msg-stream-segments, :scope > .stream-live-text"
        )
        .forEach((el) => el.remove());

      const item = {
        bubble,
        wrapper,
        segments: segments.map((s) => ({ kind: s.kind, text: s.text || "" })),
        rawText: joinSegmentText(segments, "text"),
        thinkingText: joinSegmentText(segments, "thinking"),
      };
      paintStreamSegments(item, { live: false, markdown: true, copyBtn: copy || undefined });

      if (copy) {
        copy.onclick = null;
        copy.addEventListener("click", () => {
          copyToClipboard(item.rawText || "", copy, "✓", msg.copyFail || "失败");
        });
      }
      return true;
    }

    async function hydrateProcessTrace(bubble, invocationId) {
      if (!bubble || !invocationId) return;
      if (typeof fetchInvocationEvents !== "function") return;
      const wrapper = bubble.closest ? bubble.closest(".message") : null;
      const needsUsage =
        wrapper &&
        wrapper.dataset.usageEligible !== "false" &&
        !wrapper.querySelector(".msg-usage");
      const needsProcess = !bubble.querySelector(".msg-process, .live-subagents");
      const needsStream =
        !bubble.querySelector(":scope > .msg-stream-segments") &&
        Boolean(bubble.querySelector(":scope > .msg-final-content"));
      if (!needsUsage && !needsProcess && !needsStream) return;
      try {
        const page = await fetchInvocationEvents(invocationId);
        if (!page.events || page.events.length === 0) return;
        if (needsUsage) renderMessageUsage(wrapper, aggregateInvocationUsage(page.events));
        if (needsStream) {
          hydrateInterleavedContent(bubble, page.events, wrapper);
        }
        if (!needsProcess) return;
        // History hydrate: always collapsed so the answer is primary.
        const panel = buildProcessPanelFromTranscriptEvents(page.events, {
          from: page.from || 0,
        });
        if (!panel) return;
        if (bubble.querySelector(".msg-process, .live-subagents")) return;
        const stream = bubble.querySelector(":scope > .msg-stream-segments");
        const content = bubble.querySelector(".msg-final-content");
        if (stream) bubble.insertBefore(panel, stream);
        else if (content) bubble.insertBefore(panel, content);
        else bubble.insertBefore(panel, bubble.firstChild);
      } catch (error) {
        console.warn("Process trace hydrate failed:", error);
      }
    }

    /** Queue of pending history hydrates; drained in idle chunks. */
    let _hydrateQueue = [];
    let _hydrateRunning = false;

    function drainHydrateQueue() {
      if (_hydrateRunning) return;
      _hydrateRunning = true;

      const step = () => {
        const batch = _hydrateQueue.splice(0, HYDRATE_CHUNK_SIZE);
        if (batch.length === 0) {
          _hydrateRunning = false;
          return;
        }
        Promise.all(batch.map((job) => hydrateProcessTrace(job.bubble, job.invocationId)))
          .catch(() => {})
          .finally(() => {
            if (_hydrateQueue.length === 0) {
              _hydrateRunning = false;
              return;
            }
            const ric =
              typeof requestIdleCallback === "function"
                ? requestIdleCallback
                : (cb) => setTimeout(cb, 16);
            ric(() => step());
          });
      };
      step();
    }

    function scheduleHydrateProcessTrace(bubble, invocationId) {
      if (!bubble || !invocationId) return;
      // Always idle-queue: bulk session switch must not open N parallel hydrates.
      // Short histories still finish within one or two idle ticks.
      _hydrateQueue.push({ bubble, invocationId });
      drainHydrateQueue();
    }

    function collapseProgressIntoDetails(progressEl) {
      if (!progressEl) return null;
      if (progressEl.classList && progressEl.classList.contains("msg-progress-wrap")) {
        progressEl.open = false;
        return progressEl;
      }
      const items = progressEl.querySelectorAll ? progressEl.querySelectorAll("li") : [];
      const n = items.length;
      if (n === 0) return null;
      const details = document.createElement("details");
      details.className = "msg-progress-wrap";
      details.open = false;
      const summary = document.createElement("summary");
      summary.className = "msg-progress-summary";
      const done = progressEl.querySelectorAll
        ? progressEl.querySelectorAll("li.is-done").length
        : 0;
      summary.textContent =
        done === n
          ? typeof msg.progressDone === "function"
            ? msg.progressDone(n)
            : `进度 · ${n} 步已完成`
          : typeof msg.progressPartial === "function"
            ? msg.progressPartial(done, n)
            : `进度 · ${done}/${n}`;
      details.append(summary, progressEl);
      return details;
    }

    /**
     * Render a single live assistant bubble into its final form (markdown,
     * process trace, badge). Used both for whole-stream finish and per-agent
     * exit during A2A handoffs so the prior agent does not stay on "输出中".
     */
    function finalizeLiveItem(agent, item, sessionId, options = {}) {
      if (!item || item.detached || !item.bubble || !item.wrapper) return false;

      const sid = sessionId || state.currentSessionId || "_pending";
      const error = options.error === true;

      // Drop ephemeral live status chips — they don't belong on the final card.
      item.bubble
        .querySelectorAll(".live-process-status, .live-process-chips")
        .forEach((el) => el.remove());

      const preservedProcess = item.bubble.querySelector(".msg-process");
      const preservedSubagents = item.bubble.querySelector(".live-subagents");
      if (preservedProcess) preservedProcess.remove();
      else if (preservedSubagents) preservedSubagents.remove();

      const preservedProgress =
        item.bubble.querySelector(":scope > .msg-progress-wrap") ||
        item.bubble.querySelector(":scope > .msg-progress");
      if (preservedProgress) preservedProgress.remove();

      // Prefer run.segments (full timeline) when the live item was remounted thin.
      const rt = sessionRuntime(sid);
      const invId = item.invocationId || rt.liveInvocations.get(agent);
      const run = invId ? rt.liveRuns.get(invId) : null;
      if (
        run &&
        Array.isArray(run.segments) &&
        run.segments.length > 0 &&
        (!Array.isArray(item.segments) || item.segments.length === 0)
      ) {
        item.segments = run.segments.map((s) => ({ kind: s.kind, text: s.text || "" }));
      }
      if (!Array.isArray(item.segments) || item.segments.length === 0) {
        item.segments = fallbackSegmentsFromItem(item);
      }
      item.rawText = joinSegmentText(item.segments, "text") || item.rawText || "";
      item.thinkingText = joinSegmentText(item.segments, "thinking") || item.thinkingText || "";

      if (!preservedProgress && item.progressItems && item.progressItems.length) {
        updateProgressList(item, item.progressItems);
      }
      let progressEl =
        preservedProgress ||
        item.bubble.querySelector(":scope > .msg-progress-wrap") ||
        item.bubble.querySelector(":scope > .msg-progress");
      if (progressEl && progressEl.classList && progressEl.classList.contains("msg-progress")) {
        progressEl = collapseProgressIntoDetails(progressEl);
      } else if (progressEl && progressEl.classList && progressEl.classList.contains("msg-progress-wrap")) {
        progressEl.open = false;
      }

      // Prefer a compact rebuilt process panel (collapsed) over the live expanded dump.
      let processEl = buildProcessTraceFromRun(agent, sid);
      if (!processEl && preservedProcess) {
        processEl = wrapProcessDetails(
          preservedProcess.classList.contains("msg-process")
            ? preservedProcess.querySelector(".live-subagents") || preservedProcess
            : preservedProcess,
          { open: false, live: false }
        );
      } else if (!processEl && preservedSubagents) {
        // Strip verbose summaries that may have been attached while live.
        preservedSubagents.querySelectorAll(".live-subagent-summary").forEach((el) => {
          el.textContent = "";
        });
        processEl = wrapProcessDetails(preservedSubagents, { open: false, live: false });
      }
      if (processEl && processEl.classList && processEl.classList.contains("msg-process")) {
        processEl.open = false;
        processEl.removeAttribute("data-live");
        updateProcessDetailsLabel(processEl);
      }

      let copy = item.wrapper.querySelector(".msg-copy");
      if (!copy) {
        copy = document.createElement("button");
        copy.className = "msg-copy";
        copy.textContent = "⎘";
        copy.title = "复制消息";
        copy.setAttribute("aria-label", "复制消息");
        copy.addEventListener("click", () => {
          copyToClipboard(item.rawText || "", copy, "✓", msg.copyFail || "失败");
        });
        const meta = item.wrapper.querySelector(".msg-meta");
        if (meta) meta.appendChild(copy);
      }

      // Shell: progress / process / interleaved stream (timeline order).
      item.bubble.replaceChildren();
      if (progressEl) item.bubble.appendChild(progressEl);
      if (processEl) item.bubble.appendChild(processEl);

      // Clear stale stream root so paint rebuilds finalized markdown segments.
      item.segments = item.segments.map((s) => ({ kind: s.kind, text: s.text || "" }));
      paintStreamSegments(item, { live: false, markdown: true, copyBtn: copy });

      // Fallback: no segments but have rawText
      if (
        (!item.segments || item.segments.length === 0) &&
        (item.rawText || "").length > 0
      ) {
        const content = document.createElement("div");
        content.className = "msg-final-content";
        item.bubble.appendChild(content);
        paintFinalMarkdown(content, item.rawText || "", { copyBtn: copy, host: item });
      }

      item.bubble.classList.remove("msg-bubble-live-pending");
      item.bubble.classList.remove("msg-bubble-live");

      if (item.showUsage !== false) renderMessageUsage(item.wrapper, options.usage);

      if (item.invocationId && typeof attachRecallToggle === "function") {
        attachRecallToggle(item.wrapper, item.invocationId);
      }
      item.setBadge(error ? "error" : "done");
      item.finalized = true;
      return true;
    }

    /**
     * Finalize one agent after its invocation exits (A2A handoff path).
     * Removes it from liveMessages so session remount won't re-show "输出中"
     * and won't duplicate the history bubble loaded from /api/messages.
     */
    function finalizeLiveAgent(agent, sessionId, options = {}) {
      if (!agent) return;
      const sid = sessionId || state.currentSessionId || "_pending";
      flushPendingLiveRender(sid);
      const rt = sessionRuntime(sid);
      const invId = rt.liveInvocations.get(agent);
      if (invId && rt.liveRuns.has(invId)) {
        const run = rt.liveRuns.get(invId);
        run.status = options.error === true ? "error" : "done";
        if (!options.usage && run.usage) options.usage = run.usage;
      }
      const item = rt.liveMessages.get(agent);
      if (!item) return;
      if (item.detached || !item.bubble || !item.wrapper) {
        // Background / non-viewing: session history is source of truth after exit.
        rt.liveMessages.delete(agent);
        return;
      }
      finalizeLiveItem(agent, item, sid, options);
      // Drop from live map so switchSession remount does not re-attach as writing.
      rt.liveMessages.delete(agent);
    }

    function finalizeLiveMessages(sessionId) {
      const sid = sessionId || state.currentSessionId || "_pending";
      flushPendingLiveRender(sid);
      const rt = sessionRuntime(sid);
      for (const [agent, item] of [...rt.liveMessages.entries()]) {
        if (!item) {
          rt.liveMessages.delete(agent);
          continue;
        }
        if (item.detached || !item.bubble || !item.wrapper) {
          // Completed-or-abandoned detached stubs: history will cover them.
          rt.liveMessages.delete(agent);
          continue;
        }
        finalizeLiveItem(agent, item, sid, { error: false });
        // Drop after finalize so a later switch while status is still settling
        // does not re-mount these as live "输出中" bubbles.
        rt.liveMessages.delete(agent);
      }
    }

    function finishStream(statusText, sessionId) {
      const sid = sessionId || state.currentSessionId || "_pending";
      const rt = sessionRuntime(sid);
      rt.doneReceived = true;
      if (rt.status !== "error") rt.status = "done";
      finalizeLiveMessages(sid);
      if (typeof onRuntimeStatusChange === "function") onRuntimeStatusChange(sid);
      if (!isViewingSession(sid)) return;
      if (statusText && typeof setStatus === "function") setStatus(statusText);
      const sessionController =
        typeof getSessionController === "function" ? getSessionController() : null;
      if (sessionController && typeof sessionController.loadSessions === "function") {
        sessionController.loadSessions();
      }
      if (typeof loadWorktreeStatus === "function") loadWorktreeStatus();
      if (state.rightPanelTab === "workspace" && typeof loadWorkspaceState === "function") {
        loadWorkspaceState();
      }
      if (typeof syncComposerControls === "function") syncComposerControls();
    }

    function addSystem(text, variant = "", extra = {}) {
      hideEmpty();
      ensureSpacer();
      createMessage({
        role: "system",
        agent: "system",
        content: text,
        variant,
        kind: extra.kind || "",
        messageType: extra.messageType || extra.kind || "",
        from: extra.from || null,
        to: extra.to || null,
        handoffId: extra.handoffId || null,
        routeStatus: extra.routeStatus || null,
      });

      const slot = typeof getSessionSlot === "function" ? getSessionSlot() : null;
      if (variant === "error" && slot && slot.lastPrompt) {
        const wrapper = document.createElement("article");
        wrapper.className = "message system";
        const meta = document.createElement("div");
        meta.className = "msg-meta";
        const metaLabel = document.createElement("span");
        metaLabel.className = "msg-name";
        metaLabel.textContent = roleDisplayName("system", "system");
        const metaRole = document.createElement("span");
        metaRole.className = "msg-role-label";
        metaRole.textContent = roleBadgeLabel("system");
        meta.append(metaLabel, metaRole);
        const card = document.createElement("div");
        card.className = "msg-card";
        const bubble = document.createElement("div");
        bubble.className = "msg-bubble";
        const retry = document.createElement("button");
        retry.className = "btn-retry";
        retry.textContent = "↻ 重试";
        retry.addEventListener("click", () => {
          const s = getSessionSlot();
          promptEl.value = s.lastPrompt;
          state.selectedAgent = s.lastAgent;
          if (typeof renderAgentTabs === "function") renderAgentTabs();
          const chatClient = typeof getChatClient === "function" ? getChatClient() : null;
          if (chatClient) chatClient.sendPrompt();
        });
        bubble.appendChild(retry);
        card.appendChild(bubble);
        wrapper.append(meta, card);
        messagesEl.insertBefore(wrapper, spacerEl);
        scheduleScrollDown(true);
      }
    }

    function addDebug(agent, text) {
      hideEmpty();
      ensureSpacer();
      createMessage({ role: "system", agent, content: text, variant: "stderr" });
    }

    /**
     * Re-attach or rebuild live agent bubbles after a session switch.
     * Handles: DOM wiped by switchSession, detached placeholders (updated while
     * background), and agents that only have thinking / pending status so far.
     */
    function remountLiveMessages(sessionId) {
      const rt = runtimeStore.get(sessionId);
      if (!rt || rt.liveMessages.size === 0) return;
      hideEmpty();
      ensureSpacer();

      for (const [agent, item] of [...rt.liveMessages.entries()]) {
        if (!item || item.finalized) {
          rt.liveMessages.delete(agent);
          continue;
        }

        const wrapperInDom = item.wrapper && messagesEl.contains(item.wrapper);
        if (wrapperInDom) continue;

        // Wrapper still held in memory (cleared from parent by replaceChildren).
        if (item.wrapper && !item.detached) {
          messagesEl.insertBefore(item.wrapper, spacerEl);
          continue;
        }

        // Detached / missing DOM: rebuild a live bubble from buffered state.
        // Keep empty rawText (thinking-only) so handoff targets stay visible.
        const rebuilt = createMessage({ role: "assistant", agent, content: "" });
        rebuilt.rawText = item.rawText || "";
        rebuilt.thinkingText = item.thinkingText || "";
        rebuilt.segments = Array.isArray(item.segments)
          ? item.segments.map((s) => ({ kind: s.kind, text: s.text || "" }))
          : fallbackSegmentsFromItem(item);
        rebuilt.progressItems = Array.isArray(item.progressItems) ? item.progressItems : [];
        rebuilt.pendingStatus = item.pendingStatus || "";
        rebuilt.invocationId = item.invocationId || rt.liveInvocations.get(agent) || null;

        if (rebuilt.segments.length > 0) {
          paintStreamSegments(rebuilt, { live: true, markdown: false });
          if (rebuilt.bubble) rebuilt.bubble.classList.remove("msg-bubble-live-pending");
          rebuilt.setBadge(rebuilt.rawText ? "writing" : "thinking");
        } else if (rebuilt.rawText && rebuilt._liveTextEl) {
          rebuilt._liveTextEl.textContent = rebuilt.rawText;
          if (rebuilt.bubble) rebuilt.bubble.classList.remove("msg-bubble-live-pending");
          rebuilt.setBadge("writing");
        } else {
          rebuilt.setBadge("thinking");
          if (rebuilt.pendingStatus && rebuilt._liveTextEl) {
            rebuilt._liveTextEl.textContent = rebuilt.pendingStatus;
          }
        }
        if (rebuilt.progressItems.length) updateProgressList(rebuilt, rebuilt.progressItems);

        rt.liveMessages.set(agent, rebuilt);
      }

      ensureSpacer();
      scrollDown(true);
    }

    function bindCodeBlockDelegates(documentRef) {
      const doc = documentRef || (typeof document !== "undefined" ? document : null);
      if (!doc || typeof doc.addEventListener !== "function") return;

      doc.addEventListener("click", (e) => {
        const btn = e.target.closest(".md-code-copy");
        if (!btn) return;
        const code = btn.closest(".md-code")?.querySelector("code");
        if (!code) return;
        // Plain code only — not the full message markdown.
        copyToClipboard(code.textContent, btn, msg.copyOk || "已复制", msg.copyFail || "失败");
      });

      doc.addEventListener("click", (e) => {
        const btn = e.target.closest(".md-code-toggle");
        if (!btn) return;
        const codeBlock = btn.closest(".md-code");
        if (!codeBlock) return;
        const pre = codeBlock.querySelector("pre");
        if (!pre) return;

        const isCollapsed = pre.classList.contains("md-code-pre-collapsed");
        if (isCollapsed) {
          pre.classList.remove("md-code-pre-collapsed");
          pre.classList.add("md-code-pre-expanded");
          btn.textContent = "▲";
          btn.title = "Collapse";
          btn.setAttribute("aria-label", "Collapse code");
          btn.setAttribute("aria-expanded", "true");
        } else {
          pre.classList.remove("md-code-pre-expanded");
          pre.classList.add("md-code-pre-collapsed");
          btn.textContent = "▼";
          btn.title = "Expand";
          btn.setAttribute("aria-label", "Expand code");
          btn.setAttribute("aria-expanded", "false");
        }
      });
    }

    return {
      createMessage,
      showThinking,
      stopThinking,
      appendLive,
      applyAgentEvent,
      ensureLiveRun,
      flushPendingLiveRender,
      finalizeLiveAgent,
      finalizeLiveMessages,
      finishStream,
      remountLiveMessages,
      organizeCollabMessages,
      addSystem,
      addDebug,
      ensureSpacer,
      showEmpty,
      hideEmpty,
      scrollDown,
      scheduleScrollDown,
      isNearBottom,
      setLivePending,
      pendingTextForEvent,
      upsertLiveTool,
      buildProcessTraceFromRun,
      buildProcessPanelFromTranscriptEvents,
      focusProcessPanel,
      hydrateProcessTrace,
      scheduleHydrateProcessTrace,
      updateThinkingPanel,
      updateProgressList,
      copyToClipboard,
      bindCodeBlockDelegates,
      isViewingSession,
      sessionRuntime,
      MESSAGE_VIRTUAL_THRESHOLD,
    };
  }

  const api = {
    createMessageView,
    createProcessPanelRenderer,
    normalizedUsage,
    aggregateInvocationUsage,
    compactUsageTokens,
    appendContentSegment,
    joinSegmentText,
    buildContentSegmentsFromEvents,
    fallbackSegmentsFromItem,
    MESSAGE_VIRTUAL_THRESHOLD,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.MessageView = api;
})(typeof window !== "undefined" ? window : globalThis);
