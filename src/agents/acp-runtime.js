const { makeEvent } = require("./event-protocol");
const { makeUsageEvent } = require("./usage");

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

/**
 * Grok ACP attaches vendor metadata under update._meta["x.ai/tool"].
 * @param {object} update
 * @returns {{ name?: string, label?: string, kind?: string, readOnly?: boolean }}
 */
function acpToolMeta(update) {
  const meta = update && update._meta && typeof update._meta === "object" ? update._meta : null;
  const tool =
    meta && meta["x.ai/tool"] && typeof meta["x.ai/tool"] === "object" ? meta["x.ai/tool"] : null;
  if (!tool) return {};
  return {
    name: typeof tool.name === "string" && tool.name.trim() ? tool.name.trim() : undefined,
    label: typeof tool.label === "string" && tool.label.trim() ? tool.label.trim() : undefined,
    kind: typeof tool.kind === "string" && tool.kind.trim() ? tool.kind.trim() : undefined,
    readOnly: typeof tool.read_only === "boolean" ? tool.read_only : undefined,
  };
}

/**
 * Stable tool id for protocol (prefer meta.name over human title).
 * First update often has title=spawn_subagent and no name field.
 */
function resolveToolName(update, previous) {
  const meta = acpToolMeta(update);
  if (meta.name) return meta.name;
  if (typeof update.name === "string" && update.name.trim()) return update.name.trim();
  if (previous?.toolName) return previous.toolName;
  // First packet may use title as the tool id (spawn_subagent, list_dir).
  if (typeof update.title === "string" && update.title.trim() && !previous) {
    return update.title.trim();
  }
  if (typeof update.kind === "string" && update.kind.trim() && update.kind !== "other") {
    return update.kind.trim();
  }
  return previous?.toolName || "tool";
}

/**
 * Human-readable title: prefer non-id titles over the stable toolName.
 */
function resolveToolTitle(update, previous, toolName) {
  const title = typeof update.title === "string" ? update.title.trim() : "";
  if (title && title !== toolName) return title;
  if (previous?.title && previous.title !== toolName) return previous.title;
  if (title) return title;
  return previous?.title || undefined;
}

function mergeToolArgs(update, previous) {
  const next =
    update.rawInput && typeof update.rawInput === "object" && !Array.isArray(update.rawInput)
      ? update.rawInput
      : null;
  if (!next) return previous?.args || {};
  if (!previous?.args || typeof previous.args !== "object") return { ...next };
  return { ...previous.args, ...next };
}

function optionalToolDisplayFields(current) {
  const fields = {};
  if (current.title) fields.title = current.title;
  if (current.label) fields.label = current.label;
  if (current.toolKind) fields.toolKind = current.toolKind;
  return fields;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstFiniteToken(source, keys) {
  if (!isPlainObject(source)) return undefined;
  for (const key of keys) {
    const number = Number(source[key]);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return undefined;
}

/**
 * ACP PromptResponse.usage is the official billing source. Grok currently
 * puts the same turn counters on result._meta.usage instead. Flattened
 * _meta.inputTokens is last-call only and must not replace nested usage.
 */
function usageFromPromptResult(result) {
  if (!isPlainObject(result)) return null;
  const meta = isPlainObject(result._meta) ? result._meta : null;
  const official = isPlainObject(result.usage) ? result.usage : null;
  const vendor = meta && isPlainObject(meta.usage) ? meta.usage : null;
  if (!official && !vendor) return null;
  if (!official) return vendor;
  if (firstFiniteToken(official, ["thoughtTokens", "reasoningTokens"]) !== undefined || !vendor) {
    return official;
  }
  const vendorReasoning = firstFiniteToken(vendor, ["thoughtTokens", "reasoningTokens"]);
  return vendorReasoning === undefined
    ? official
    : { ...official, reasoningTokens: vendorReasoning };
}

function usdCostFromUpdate(update) {
  if (update?.cost?.currency !== "USD") return undefined;
  const amount = Number(update.cost.amount);
  return Number.isFinite(amount) && amount >= 0 ? amount : undefined;
}

function extractSubagentId(result) {
  if (!result) return null;
  if (typeof result === "string") {
    const match = result.match(/subagent_id:\s*([^\s\r\n]+)/i);
    return match ? match[1].trim() : null;
  }
  if (typeof result === "object") {
    if (typeof result.subagent_id === "string" && result.subagent_id.trim()) {
      return result.subagent_id.trim();
    }
    if (typeof result.subagentId === "string" && result.subagentId.trim()) {
      return result.subagentId.trim();
    }
    if (typeof result.text === "string") {
      const match = result.text.match(/subagent_id:\s*([^\s\r\n]+)/i);
      return match ? match[1].trim() : null;
    }
  }
  return null;
}

function createAcpRuntime(config = {}) {
  let rootSessionId =
    typeof config?.resumeSessionId === "string" && config.resumeSessionId.trim()
      ? config.resumeSessionId.trim()
      : null;
  const sessions = new Map();
  const subagentToParentTool = new Map();

  function getOrCreateSession(sessionId) {
    const id =
      typeof sessionId === "string" && sessionId.trim()
        ? sessionId.trim()
        : rootSessionId || "";
    let session = sessions.get(id);
    if (!session) {
      const isRoot = !rootSessionId || id === rootSessionId;
      if (!rootSessionId && id) {
        rootSessionId = id;
      }
      session = {
        sessionId: id,
        isRoot,
        parentToolId: subagentToParentTool.get(id) || null,
        tools: new Map(),
        thinkingBuffer: "",
        textBuffer: "",
      };
      sessions.set(id, session);
    }
    return session;
  }

  function sessionMetadata(session) {
    if (session.isRoot) return {};
    return {
      subagentId: session.sessionId,
      ...(session.parentToolId ? { parentToolId: session.parentToolId } : {}),
      sessionId: session.sessionId,
    };
  }

  function base(ctx) {
    return {
      agent: ctx.agent,
      invocationId: ctx.invocationId,
    };
  }

  function flushSessionBuffers(session, ctx, force = false) {
    const out = [];
    const meta = sessionMetadata(session);
    if (
      session.thinkingBuffer &&
      (force || session.thinkingBuffer.length >= ACP_THINKING_FLUSH_CHARS)
    ) {
      out.push(
        makeEvent("thinking.delta", {
          ...base(ctx),
          text: session.thinkingBuffer,
          ...meta,
        })
      );
      session.thinkingBuffer = "";
    }
    if (session.textBuffer && (force || session.textBuffer.length >= ACP_TEXT_FLUSH_CHARS)) {
      if (session.isRoot) {
        out.push(makeEvent("text.delta", { ...base(ctx), text: session.textBuffer }));
      } else {
        // Child session text must NOT become text.delta of the parent agent.
        out.push(
          makeEvent("commentary.delta", {
            ...base(ctx),
            text: session.textBuffer,
            ...meta,
          })
        );
      }
      session.textBuffer = "";
    }
    return out;
  }

  function mapTool(session, update, ctx) {
    const out = flushSessionBuffers(session, ctx, true);
    const toolId = String(update.toolCallId || "");
    if (!toolId) return out;

    const previous = session.tools.get(toolId);
    const meta = acpToolMeta(update);
    const toolName = resolveToolName(update, previous);
    const title = resolveToolTitle(update, previous, toolName);
    const label = meta.label || previous?.label;
    const toolKind = meta.kind || previous?.toolKind;
    const current = {
      toolId,
      toolName,
      title,
      label,
      toolKind,
      args: mergeToolArgs(update, previous),
      status: update.status || previous?.status || "pending",
      finished: previous?.finished || false,
    };
    session.tools.set(toolId, current);

    const sMeta = sessionMetadata(session);

    if (!previous) {
      out.push(
        makeEvent("tool.started", {
          ...base(ctx),
          toolName: current.toolName,
          toolId,
          args: current.args,
          ...optionalToolDisplayFields(current),
          ...sMeta,
        })
      );
    }

    if (["completed", "failed"].includes(current.status) && !current.finished) {
      current.finished = true;
      const result = toolResult(update);
      if (
        session.isRoot &&
        (current.toolName === "spawn_subagent" || current.toolKind === "task")
      ) {
        const subId = extractSubagentId(result);
        if (subId) {
          subagentToParentTool.set(subId, current.toolId);
          const childSession = sessions.get(subId);
          if (childSession && !childSession.parentToolId) {
            childSession.parentToolId = current.toolId;
          }
        }
      }
      out.push(
        makeEvent("tool.finished", {
          ...base(ctx),
          toolName: current.toolName,
          toolId,
          status: current.status === "failed" ? "error" : "ok",
          // Final merged args (ACP often completes rawInput only on tool_call_update).
          args: current.args && Object.keys(current.args).length ? current.args : undefined,
          result,
          ...optionalToolDisplayFields(current),
          ...sMeta,
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
            ...sMeta,
          })
        );
      }
    }
    return out;
  }

  return {
    extractSessionId(event) {
      if (rootSessionId) return rootSessionId;
      if (
        event?.type === "acp.session_started" &&
        typeof event?.sessionId === "string" &&
        event.sessionId.trim()
      ) {
        return event.sessionId.trim();
      }
      return typeof event?.sessionId === "string" ? event.sessionId : "";
    },
    transform(event, ctx) {
      if (!event || typeof event !== "object") return [];
      if (event.type === "acp.session_started") {
        if (typeof event.sessionId === "string" && event.sessionId.trim()) {
          const sid = event.sessionId.trim();
          rootSessionId = sid;
          const root = getOrCreateSession(sid);
          root.isRoot = true;
        }
        return [];
      }
      if (event.type === "acp.permission_denied") {
        const session = getOrCreateSession(event.sessionId);
        const sMeta = sessionMetadata(session);
        return [
          makeEvent("diagnostic", {
            ...base(ctx),
            code: String(event.reason || "acp_permission_denied"),
            message: `ACP ${event.toolKind || "other"} tool denied by the implementation gate.`,
            ...(event.toolCallId ? { toolId: String(event.toolCallId) } : {}),
            ...sMeta,
          }),
        ];
      }
      if (event.type === "acp.prompt_result") {
        const root = getOrCreateSession(rootSessionId);
        const usageEvent = makeUsageEvent(base(ctx), usageFromPromptResult(event.result), {
          scope: "turn",
          mode: "cumulative",
        });
        return [...flushSessionBuffers(root, ctx, true), ...(usageEvent ? [usageEvent] : [])];
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

      const session = getOrCreateSession(event.sessionId);
      const update = event.update;
      if (!update || typeof update !== "object") return [];
      switch (update.sessionUpdate) {
        case "agent_message_chunk": {
          const text = contentText(update.content);
          const out = [];
          if (session.thinkingBuffer) out.push(...flushSessionBuffers(session, ctx, true));
          if (text) session.textBuffer += text;
          out.push(...flushSessionBuffers(session, ctx));
          return out;
        }
        case "agent_thought_chunk": {
          const text = contentText(update.content);
          const out = [];
          if (session.textBuffer) out.push(...flushSessionBuffers(session, ctx, true));
          if (text) session.thinkingBuffer += text;
          out.push(...flushSessionBuffers(session, ctx));
          return out;
        }
        case "tool_call":
        case "tool_call_update":
          return mapTool(session, update, ctx);
        case "plan":
        case "plan_update":
          return [
            ...flushSessionBuffers(session, ctx, true),
            makeEvent("progress.update", {
              ...base(ctx),
              items: Array.isArray(update.entries)
                ? update.entries.map((entry, index) => ({
                    ...entry,
                    id: entry.id || `step-${index + 1}`,
                    label: entry.content || entry.title || "",
                  }))
                : [],
              ...sessionMetadata(session),
            }),
          ];
        case "usage_update": {
          const occupancy = Number(update.used);
          const hasOccupancy = Number.isFinite(occupancy) && occupancy >= 0;
          const costUsd = usdCostFromUpdate(update);
          if (!hasOccupancy && costUsd === undefined) {
            return flushSessionBuffers(session, ctx, true);
          }
          const usageEvent = makeUsageEvent(
            base(ctx),
            {
              ...(hasOccupancy ? { contextTokens: occupancy } : {}),
              contextWindowTokens: update.size,
              ...(costUsd !== undefined ? { costUsd } : {}),
            },
            {
              scope: "turn",
              mode: "cumulative",
              contextTokensExact: hasOccupancy,
            }
          );
          if (usageEvent && !session.isRoot) {
            Object.assign(usageEvent, sessionMetadata(session));
          }
          return [...flushSessionBuffers(session, ctx, true), ...(usageEvent ? [usageEvent] : [])];
        }
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
              ...sessionMetadata(session),
            }),
          ];
      }
    },
    finish(ctx) {
      const out = [];
      for (const session of sessions.values()) {
        out.push(...flushSessionBuffers(session, ctx, true));
      }
      return out;
    },
  };
}

module.exports = {
  ACP_TEXT_FLUSH_CHARS,
  ACP_THINKING_FLUSH_CHARS,
  contentText,
  createAcpRuntime,
  extractSubagentId,
  toolResult,
  acpToolMeta,
  resolveToolName,
  resolveToolTitle,
};
