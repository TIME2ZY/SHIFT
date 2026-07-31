const { makeEvent } = require("./event-protocol");

const ACP_THINKING_FLUSH_CHARS = 80;
const ACP_TEXT_FLUSH_CHARS = 40;

function contentText(content) {
  if (!content || typeof content !== "object") return "";
  if (content.type === "text" && typeof content.text === "string") return content.text;
  return "";
}

function toolResult(update) {
  if (update.rawOutput !== undefined && update.rawOutput !== null) return update.rawOutput;
  if (!Array.isArray(update.content)) return null;
  const values = update.content
    .map((item) => {
      if (item?.type === "content") return contentText(item.content);
      if (item?.type === "diff") return item;
      if (item?.type === "terminal") return item;
      return null;
    })
    .filter((value) => value !== null && value !== "");
  if (values.length === 0) return null;
  return values.length === 1 ? values[0] : values;
}

function createAcpRuntime(_config = {}) {
  const tools = new Map();
  let thinkingBuffer = "";
  let textBuffer = "";

  function base(ctx) {
    return {
      agent: ctx.agent,
      invocationId: ctx.invocationId,
    };
  }

  function toolName(update, previous) {
    return String(update.name || previous?.toolName || update.title || update.kind || "tool");
  }

  function flushBuffers(ctx, force = false) {
    const out = [];
    if (thinkingBuffer && (force || thinkingBuffer.length >= ACP_THINKING_FLUSH_CHARS)) {
      out.push(makeEvent("thinking.delta", { ...base(ctx), text: thinkingBuffer }));
      thinkingBuffer = "";
    }
    if (textBuffer && (force || textBuffer.length >= ACP_TEXT_FLUSH_CHARS)) {
      out.push(makeEvent("text.delta", { ...base(ctx), text: textBuffer }));
      textBuffer = "";
    }
    return out;
  }

  function mapTool(update, ctx) {
    const out = flushBuffers(ctx, true);
    const toolId = String(update.toolCallId || "");
    if (!toolId) return out;

    const previous = tools.get(toolId);
    const current = {
      toolId,
      toolName: toolName(update, previous),
      args:
        update.rawInput && typeof update.rawInput === "object" && !Array.isArray(update.rawInput)
          ? update.rawInput
          : previous?.args || {},
      status: update.status || previous?.status || "pending",
      finished: previous?.finished || false,
    };
    tools.set(toolId, current);

    if (!previous) {
      out.push(
        makeEvent("tool.started", {
          ...base(ctx),
          toolName: current.toolName,
          toolId,
          args: current.args,
        })
      );
    }

    if (["completed", "failed"].includes(current.status) && !current.finished) {
      current.finished = true;
      out.push(
        makeEvent("tool.finished", {
          ...base(ctx),
          toolName: current.toolName,
          toolId,
          status: current.status === "failed" ? "error" : "ok",
          result: toolResult(update),
        })
      );
    }

    if (["edit", "delete", "move"].includes(update.kind) && Array.isArray(update.locations)) {
      for (const location of update.locations) {
        if (!location || typeof location.path !== "string" || !location.path) continue;
        out.push(
          makeEvent("file.changed", {
            ...base(ctx),
            path: location.path,
          })
        );
      }
    }
    return out;
  }

  return {
    extractSessionId(event) {
      return typeof event?.sessionId === "string" ? event.sessionId : "";
    },
    transform(event, ctx) {
      if (!event || typeof event !== "object") return [];
      if (event.type === "acp.session_started") return [];
      if (event.type === "acp.prompt_result") {
        const usage = event.result?.usage;
        if (!usage || typeof usage !== "object") return [];
        return [
          ...flushBuffers(ctx, true),
          makeEvent("usage.update", {
            ...base(ctx),
            scope: "turn",
            mode: "cumulative",
            inputTokens: Number(usage.inputTokens || 0),
            cachedInputTokens: Number(usage.cachedReadTokens || 0),
            outputTokens: Number(usage.outputTokens || 0),
            reasoningTokens: Number(usage.thoughtTokens || 0),
            totalTokens: Number(usage.totalTokens || 0),
          }),
        ];
      }
      if (event.type !== "acp.session_update") {
        return [
          makeEvent("diagnostic", {
            ...base(ctx),
            code: "unmapped_acp_event",
            rawType: String(event.type || "unknown"),
            message: "ACP event type not mapped to canonical protocol",
          }),
        ];
      }

      const update = event.update;
      if (!update || typeof update !== "object") return [];
      switch (update.sessionUpdate) {
        case "agent_message_chunk": {
          const text = contentText(update.content);
          const out = [];
          if (thinkingBuffer) out.push(...flushBuffers(ctx, true));
          if (text) textBuffer += text;
          out.push(...flushBuffers(ctx));
          return out;
        }
        case "agent_thought_chunk": {
          const text = contentText(update.content);
          const out = [];
          if (textBuffer) out.push(...flushBuffers(ctx, true));
          if (text) thinkingBuffer += text;
          out.push(...flushBuffers(ctx));
          return out;
        }
        case "tool_call":
        case "tool_call_update":
          return mapTool(update, ctx);
        case "plan":
        case "plan_update":
          return [
            ...flushBuffers(ctx, true),
            makeEvent("progress.update", {
              ...base(ctx),
              items: Array.isArray(update.entries)
                ? update.entries.map((entry, index) => ({
                    ...entry,
                    id: entry.id || `step-${index + 1}`,
                    label: entry.content || entry.title || "",
                  }))
                : [],
            }),
          ];
        case "usage_update":
          return [
            ...flushBuffers(ctx, true),
            makeEvent("usage.update", {
              ...base(ctx),
              scope: "turn",
              mode: "cumulative",
              totalTokens: Number(update.used || 0),
              contextTokens: Number.isFinite(update.size) ? update.size : null,
              contextTokensExact: true,
              ...(update.cost?.currency === "USD" && Number.isFinite(update.cost.amount)
                ? { costUsd: update.cost.amount }
                : {}),
            }),
          ];
        case "user_message_chunk":
        case "available_commands_update":
        case "current_mode_update":
        case "config_option_update":
        case "session_info_update":
        case "plan_removed":
          return [];
        default:
          return [
            makeEvent("diagnostic", {
              ...base(ctx),
              code: "unmapped_acp_update",
              rawType: String(update.sessionUpdate || "unknown"),
              message: "ACP session update not mapped to canonical protocol",
            }),
          ];
      }
    },
    finish(ctx) {
      return flushBuffers(ctx, true);
    },
  };
}

module.exports = {
  ACP_TEXT_FLUSH_CHARS,
  ACP_THINKING_FLUSH_CHARS,
  contentText,
  createAcpRuntime,
  toolResult,
};
