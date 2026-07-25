/**
 * Pure helpers for message process / tool / subagent cards.
 * Extracted from message-view so event rendering stays testable without DOM.
 */
(function initMessageProcessHelpers(globalScope) {
  "use strict";

  function collapseWs(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function truncateDisplay(text, max = 160) {
    const value = collapseWs(text);
    if (!value) return "";
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
  }

  function cleanProcessOutput(text) {
    let value = String(text || "");
    if (!value) return "";
    const resultMatch = value.match(/<task_result>\s*([\s\S]*?)\s*<\/task_result>/i);
    if (resultMatch && resultMatch[1]) value = resultMatch[1];
    value = value
      .replace(/<\/?task\b[^>]*>/gi, " ")
      .replace(/<\/?task_result\b[^>]*>/gi, " ")
      .replace(/<\/?[^>]+>/g, " ")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\|/g, " ");
    return collapseWs(value);
  }

  function toolDetailFromEvent(event) {
    if (!event) return "";
    if (typeof event.command === "string" && event.command.trim()) {
      return truncateDisplay(event.command, 140);
    }
    const args = event.args && typeof event.args === "object" ? event.args : {};
    // OpenCode uses filePath; Codex-style tools use path/file.
    const preferred =
      args.title ||
      args.description ||
      args.command ||
      args.cmd ||
      args.path ||
      args.file ||
      args.filePath ||
      args.file_path ||
      args.filepath ||
      args.pattern ||
      event.task ||
      "";
    return truncateDisplay(preferred, 140);
  }

  function isContentDumpTool(event) {
    const name = String((event && event.toolName) || "").toLowerCase();
    return /^(read|glob|grep|list|search|find|cat|ls|dir|view|get)\b/.test(name)
      || name.includes("read")
      || name.includes("glob")
      || name.includes("grep")
      || name.includes("list_dir")
      || name.includes("list-dir");
  }

  function processSummaryFromEvent(event) {
    if (!event) return "";
    if (typeof event.error === "string" && event.error.trim()) {
      return truncateDisplay(cleanProcessOutput(event.error), 120);
    }
    if (event.status === "error") {
      if (typeof event.output === "string" && event.output.trim()) {
        return truncateDisplay(cleanProcessOutput(event.output), 120);
      }
      if (event.result != null) {
        const raw = typeof event.result === "string" ? event.result : JSON.stringify(event.result);
        return truncateDisplay(cleanProcessOutput(raw), 120);
      }
    }
    if (typeof event.summary === "string" && event.summary.trim()) {
      const cleaned = cleanProcessOutput(event.summary);
      if (cleaned.length <= 80) return cleaned;
      return truncateDisplay(cleaned, 80);
    }
    if (
      event.type === "tool.finished"
      || event.type === "tool.started"
      || isContentDumpTool(event)
    ) {
      return "";
    }
    if (typeof event.output === "string" && event.output.trim()) {
      return truncateDisplay(cleanProcessOutput(event.output), 80);
    }
    if (event.result != null) {
      const raw = typeof event.result === "string" ? event.result : JSON.stringify(event.result);
      return truncateDisplay(cleanProcessOutput(raw), 80);
    }
    if (typeof event.text === "string" && event.text.trim()) {
      return truncateDisplay(cleanProcessOutput(event.text), 80);
    }
    return "";
  }

  function isTaskLikeTool(event) {
    const name = String((event && event.toolName) || "").toLowerCase();
    if (name === "task" || name.endsWith(".task")) return true;
    const args = event && event.args && typeof event.args === "object" ? event.args : {};
    return Boolean(args.subagent_type || args.subagentType);
  }

  function progressItemLabel(item) {
    if (!item || typeof item !== "object") return String(item || "");
    return item.text || item.label || item.title || item.description || "";
  }

  function progressItemDone(item) {
    if (!item || typeof item !== "object") return false;
    if (item.done === true || item.status === "done" || item.status === "completed") return true;
    if (item.done === false) return false;
    return false;
  }

  /**
   * Normalize provider capabilities for UI fallbacks.
   * Missing capabilities object → optimistic full support (legacy agents / offline).
   * Explicit false → hide that surface.
   */
  function resolveCapabilities(agentOrCaps) {
    const defaults = {
      resume: true,
      thinking: true,
      tools: true,
      reasoning: "none",
    };
    if (!agentOrCaps || typeof agentOrCaps !== "object") return { ...defaults };
    const raw =
      agentOrCaps.capabilities && typeof agentOrCaps.capabilities === "object"
        ? agentOrCaps.capabilities
        : agentOrCaps.thinking !== undefined ||
            agentOrCaps.tools !== undefined ||
            agentOrCaps.resume !== undefined
          ? agentOrCaps
          : null;
    if (!raw) return { ...defaults };
    return {
      resume: raw.resume !== false,
      thinking: raw.thinking !== false,
      tools: raw.tools !== false,
      reasoning: raw.reasoning != null ? raw.reasoning : defaults.reasoning,
    };
  }

  function findAgentCapabilities(agents, agentId) {
    const list = Array.isArray(agents) ? agents : [];
    const agent = list.find((a) => a && a.id === agentId);
    return resolveCapabilities(agent || null);
  }

  function shouldRenderThinking(caps) {
    return Boolean(resolveCapabilities(caps).thinking);
  }

  function shouldRenderTools(caps) {
    return Boolean(resolveCapabilities(caps).tools);
  }

  /** Short UI tags for agent panel (capability-driven, not provider-name hardcoding). */
  function capabilityTagList(agentOrCaps) {
    const caps = resolveCapabilities(agentOrCaps);
    const tags = [];
    if (caps.thinking) tags.push("思考");
    if (caps.tools) tags.push("工具");
    return tags;
  }

  /** Attach absolute event index for Phase B focus / highlight. */
  function resolveEventNo(evt) {
    if (!evt || typeof evt !== "object") return null;
    if (Number.isInteger(evt.eventNo)) return evt.eventNo;
    if (Number.isInteger(evt.sequenceNo)) return evt.sequenceNo;
    return null;
  }

  function mergeEventNos(prev, evt) {
    const nos = Array.isArray(prev && prev._eventNos) ? prev._eventNos.slice() : [];
    const n = resolveEventNo(evt);
    if (n != null && !nos.includes(n)) nos.push(n);
    return nos;
  }

  /**
   * Map a single event to a process-row anchor (for focus/highlight).
   * @returns {{ rowKind: "tool", rowId: string } | null}
   */
  function processAnchorFromEvent(evt) {
    if (!evt || typeof evt !== "object") return null;
    const kind = evt.kind || evt.type || "";
    const payload = evt.payload && typeof evt.payload === "object" ? evt.payload : null;
    const data = payload
      ? payload.type
        ? payload
        : { ...payload, type: kind }
      : evt;
    const type = data.type || kind;
    if (!type) return null;

    // Legacy transcript: subagent.* / command.* fold into tool anchors.
    if (type.startsWith("subagent.")) {
      const id = String(data.subagentId || data.toolId || data.name || "");
      if (!id) return null;
      return { rowKind: "tool", rowId: id };
    }
    if (type === "command.started" || type === "command.finished") {
      if (!data.command) return null;
      return { rowKind: "tool", rowId: String(data.command) };
    }
    if (type === "tool.started" || type === "tool.finished") {
      const detail = toolDetailFromEvent(data);
      const id = String(data.toolId || `${data.toolName || "tool"}:${detail}`);
      return { rowKind: "tool", rowId: id };
    }
    return null;
  }

  /**
   * Pure data contract: transcript/SSE-shaped events → process buckets.
   * Shared by message hydrate, live final panel, and recall (no DOM).
   * Accepts either durable { kind, payload } or live { type, ...fields }.
   * Each bucket value may include `_eventNos: number[]` for Phase B focus.
   *
   * Nested CLI subagents are not a live protocol surface. Legacy transcript
   * kinds `subagent.*` fold into toolById for recall of old sessions.
   * `subById` stays empty for API stability with existing callers.
   *
   * @param {Array<object>} events
   * @returns {{ subById: Map<string, object>, toolById: Map<string, object>, commandByKey: Map<string, object> }}
   */
  function aggregateProcessBuckets(events) {
    // subById / commandByKey kept empty for caller API stability; everything is tools.
    const subById = new Map();
    const toolById = new Map();
    const commandByKey = new Map();

    for (const evt of events || []) {
      if (!evt || typeof evt !== "object") continue;
      const kind = evt.kind || evt.type || "";
      const payload = evt.payload && typeof evt.payload === "object" ? evt.payload : null;
      // Live events are flat; durable events nest fields under payload.
      const data = payload
        ? payload.type
          ? payload
          : { ...payload, type: kind }
        : evt;
      const type = data.type || kind;
      if (!type) continue;

      if (type === "diagnostic") {
        if (data.visibility === "hidden") continue;
        const id = String(data.fingerprint || data.code || `diagnostic-${toolById.size}`);
        const prev = toolById.get(id) || {};
        const count = Math.max(1, Number(data.count) || 1);
        toolById.set(id, {
          ...prev,
          ...data,
          type: "tool.finished",
          toolName: count > 1 ? `诊断 × ${count}` : "诊断",
          toolId: id,
          args: { description: data.message || data.code || "Provider diagnostic" },
          status: data.severity === "error" ? "error" : "ok",
          _eventNos: mergeEventNos(prev, evt),
          _traceKind: "diagnostic",
          _traceId: id,
        });
        continue;
      }

      if (type.startsWith("subagent.")) {
        const id = String(data.subagentId || data.toolId || data.name || toolById.size);
        const prev = toolById.get(id) || {};
        const finished =
          type === "subagent.completed" || type === "subagent.failed";
        toolById.set(id, {
          ...prev,
          ...data,
          type: finished ? "tool.finished" : "tool.started",
          toolName: data.toolName || data.name || "task",
          toolId: id,
          args: data.args || prev.args || { task: data.task },
          result: data.summary !== undefined ? data.summary : data.result ?? prev.result,
          status:
            type === "subagent.failed"
              ? "error"
              : finished
                ? "ok"
                : data.status || prev.status,
          _eventNos: mergeEventNos(prev, evt),
          _traceKind: "tool",
          _traceId: id,
        });
        continue;
      }
      // Legacy command.* → tool rows (command string as id / args.command).
      if (type === "command.started" || type === "command.finished") {
        if (!data.command) continue;
        const id = String(data.command);
        const prev = toolById.get(id) || {};
        const finished = type === "command.finished";
        const failed =
          finished && data.exitCode !== undefined && data.exitCode !== 0;
        toolById.set(id, {
          ...prev,
          ...data,
          type: finished ? "tool.finished" : "tool.started",
          toolName: "command_execution",
          toolId: id,
          args: { command: data.command, ...(data.args || prev.args || {}) },
          result: data.output !== undefined ? data.output : data.result ?? prev.result,
          output: data.output !== undefined ? data.output : prev.output,
          status: failed ? "error" : finished ? "ok" : data.status || prev.status,
          _eventNos: mergeEventNos(prev, evt),
          _traceKind: "tool",
          _traceId: id,
        });
        continue;
      }
      if (type === "tool.started" || type === "tool.finished") {
        const detail = toolDetailFromEvent(data);
        const id = String(data.toolId || `${data.toolName || "tool"}:${detail}`);
        const prev = toolById.get(id) || {};
        toolById.set(id, {
          ...prev,
          ...data,
          type,
          args: data.args || prev.args,
          toolName: data.toolName || prev.toolName,
          result: data.result !== undefined ? data.result : prev.result,
          output: data.output !== undefined ? data.output : prev.output,
          status: data.status || prev.status,
          _eventNos: mergeEventNos(prev, evt),
          _traceKind: "tool",
          _traceId: id,
        });
      }
    }

    return { subById, toolById, commandByKey };
  }

  /**
   * Stamp absolute eventNo on a page slice when the store omits it.
   * Search hits use the same absolute index.
   */
  function stampEventNos(events, from = 0) {
    const start = Math.max(0, Number(from) || 0);
    return (events || []).map((evt, i) => {
      if (!evt || typeof evt !== "object") return evt;
      if (Number.isInteger(evt.eventNo)) return evt;
      return { ...evt, eventNo: start + i };
    });
  }

  function isProcessBucketsEmpty(buckets) {
    if (!buckets) return true;
    const sub = buckets.subById;
    const tool = buckets.toolById;
    const cmd = buckets.commandByKey;
    return (
      !(sub && sub.size) &&
      !(tool && tool.size) &&
      !(cmd && cmd.size)
    );
  }

  /**
   * Lightweight text.delta / text.final concatenation for empty-process UI.
   * @param {Array<object>} events
   * @param {number} [max=200]
   */
  function textDeltaSummary(events, max = 200) {
    let out = "";
    for (const evt of events || []) {
      if (!evt || typeof evt !== "object") continue;
      const kind = evt.kind || evt.type || "";
      if (kind !== "text.delta" && kind !== "text.final") continue;
      const payload = evt.payload && typeof evt.payload === "object" ? evt.payload : evt;
      const t = typeof payload.text === "string" ? payload.text : "";
      if (!t) continue;
      out += t;
      if (out.length >= max * 2) break;
    }
    return truncateDisplay(out, max);
  }

  const api = {
    collapseWs,
    truncateDisplay,
    cleanProcessOutput,
    toolDetailFromEvent,
    isContentDumpTool,
    processSummaryFromEvent,
    isTaskLikeTool,
    progressItemLabel,
    progressItemDone,
    resolveCapabilities,
    findAgentCapabilities,
    shouldRenderThinking,
    shouldRenderTools,
    capabilityTagList,
    resolveEventNo,
    processAnchorFromEvent,
    aggregateProcessBuckets,
    isProcessBucketsEmpty,
    textDeltaSummary,
    stampEventNos,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.MessageProcessHelpers = api;
})(typeof window !== "undefined" ? window : globalThis);
