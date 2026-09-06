const { makeEvent } = require("../event-protocol");
const { makeUsageEvent } = require("../usage");
const fs = require("node:fs");
const path = require("node:path");
const { resolveProxy } = require("../proxy");
const { createOpencodeShiftContextConfig } = require("../shift-context-mcp-config");
const {
  toolNameFromItem,
  toolArgsFromItem,
  toolResultFromItem,
  exitCodeFromItem,
  classifyShellOutcome,
  summarizeResult,
  toolItemId,
} = require("../tool-classification");

/**
 * OpenCode CLI provider — one runtime for all models.
 *
 * Headless (verified opencode 1.17.x):
 *   opencode run --format json --thinking --auto \
 *     --model provider/model --variant max "prompt"
 *
 * Event shapes (model-agnostic; only -m / --variant change which model runs):
 *   step_start / step_finish  → progress.update + usage.update
 *   reasoning                 → thinking.delta  (needs --thinking)
 *   text                      → text.delta      (often full part text, not micro-tokens)
 *   tool_use                  → tool.started + tool.finished (often already completed)
 *   sessionID on each line    → resume / run.started.sessionId
 *
 * Reasoning effort maps to OpenCode `--variant` (provider-specific, e.g. max/high/low).
 * Usage comes from part.tokens / part.cost on step_finish.
 */

function sessionIdFromEvent(event) {
  if (!event || typeof event !== "object") return "";
  if (typeof event.sessionID === "string" && event.sessionID) return event.sessionID;
  if (typeof event.session_id === "string" && event.session_id) return event.session_id;
  if (event.session && typeof event.session.id === "string") return event.session.id;
  const part = event.part;
  if (part && typeof part.sessionID === "string" && part.sessionID) return part.sessionID;
  return "";
}

/** Normalize OpenCode path-like fields for UI toolDetailFromEvent (path/file). */
function normalizeToolArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args || {};
  const next = { ...args };
  const pathLike =
    (typeof next.path === "string" && next.path) ||
    (typeof next.file === "string" && next.file) ||
    (typeof next.filePath === "string" && next.filePath) ||
    (typeof next.file_path === "string" && next.file_path) ||
    (typeof next.filepath === "string" && next.filepath) ||
    "";
  if (pathLike && typeof next.path !== "string") next.path = pathLike;
  return next;
}

function createOpencodeRuntime(cli) {
  const parts = new Map();
  const reasoningParts = new Map();
  const toolStates = new Map();
  let emittedRunStarted = false;
  let lastStep = -1;

  function isReasoningPartType(type) {
    const t = String(type || "").toLowerCase();
    return t === "reasoning" || t === "thinking" || t === "thought" || t === "reason";
  }

  function reasoningTextFromPart(part) {
    if (!part || typeof part !== "object") return "";
    if (typeof part.text === "string") return part.text;
    if (typeof part.content === "string") return part.content;
    if (typeof part.reasoning === "string") return part.reasoning;
    if (typeof part.thinking === "string") return part.thinking;
    return "";
  }

  /**
   * Map OpenCode reasoning/thinking parts into thinking.delta events.
   * Real CLI (with --thinking) emits: { type: "reasoning", part: { type: "reasoning", text } }
   * Streaming builds may also push message.part.updated with growing part.text.
   */
  function thinkingEventsFromPart(part, base) {
    if (!part || !isReasoningPartType(part.type)) return [];
    const next = reasoningTextFromPart(part);
    if (!next) return [];
    const id = part.id || "_reasoning";
    const prev = reasoningParts.get(id) || "";
    reasoningParts.set(id, next);
    if (!next.startsWith(prev)) {
      // Non-monotonic update: emit full snapshot as a delta replacement for the UI.
      return [makeEvent("thinking.delta", { ...base, text: next })];
    }
    const delta = next.slice(prev.length);
    return delta ? [makeEvent("thinking.delta", { ...base, text: delta })] : [];
  }

  function normalizePart(event) {
    const part = event.part || (event.properties && event.properties.part) || null;
    if (!part || typeof part !== "object") return null;
    // Some OpenCode builds nest live tool state under part.state.
    const state = part.state && typeof part.state === "object" ? part.state : null;
    if (state) {
      return {
        ...part,
        status: part.status || state.status || state.state || "",
        arguments:
          part.arguments || part.args || part.input || state.input || state.arguments || state.args,
        args: part.args || state.args,
        input: part.input || state.input,
        output: part.output !== undefined ? part.output : state.output,
        result: part.result !== undefined ? part.result : state.result,
        error: part.error !== undefined ? part.error : state.error,
        title: part.title || state.title || "",
      };
    }
    return part;
  }

  function extractStepNumber(event, part) {
    const candidates = [
      event && event.step,
      event && event.stepIndex,
      event && event.step_index,
      part && part.step,
      part && part.index,
    ];
    for (const value of candidates) {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    return null;
  }

  function commandFromArgs(toolName, args) {
    if (!args || typeof args !== "object") return "";
    if (typeof args.command === "string" && args.command.trim()) return args.command.trim();
    if (typeof args.cmd === "string" && args.cmd.trim()) return args.cmd.trim();
    if (Array.isArray(args.command)) return args.command.map(String).join(" ");
    if (typeof args.pattern === "string" && /bash|shell|exec/i.test(toolName)) {
      return args.pattern.trim();
    }
    return "";
  }

  function toolLabelArgs(toolName, args) {
    const normalized = normalizeToolArgs(args);
    if (!normalized || typeof normalized !== "object") return {};
    // Prefer compact labels for live UI / recall.
    if (typeof normalized.path === "string") return { path: normalized.path, ...normalized };
    if (typeof normalized.pattern === "string" && !normalized.command) {
      return { pattern: normalized.pattern, ...normalized };
    }
    return normalized;
  }

  function isBashLike(toolName) {
    const name = String(toolName || "").toLowerCase();
    return (
      name === "bash" ||
      name === "shell" ||
      name === "exec" ||
      name === "run_terminal_cmd" ||
      name.endsWith(".bash") ||
      name.includes("shell") ||
      name.includes("terminal")
    );
  }

  function toolEventsFromPart(part, base) {
    if (!part || typeof part !== "object") return [];
    const type = String(part.type || "").toLowerCase();
    if (!(
      type === "tool" ||
      type === "tool_call" ||
      type === "toolcall" ||
      type === "mcp" ||
      type === "task" ||
      type === "bash" ||
      type === "read" ||
      type === "glob" ||
      type === "grep" ||
      type === "write" ||
      type === "edit"
    )) {
      if (!part.tool && !part.name && !part.toolName && !part.tool_name) return [];
    }

    const toolName = toolNameFromItem(part) || part.tool || part.name || type || "tool";
    const args = toolLabelArgs(toolName, toolArgsFromItem(part));
    const toolId = toolItemId(part, toolName);
    const status = String(part.status || part.state || "").toLowerCase();
    const prev = toolStates.get(toolId) || { started: false, finished: false };
    const events = [];

    const looksRunning =
      !status ||
      ["pending", "running", "in_progress", "start", "started", "call", "partial"].includes(status);
    const looksDone =
      [
        "completed",
        "complete",
        "done",
        "success",
        "ok",
        "error",
        "failed",
        "cancelled",
        "canceled",
      ].includes(status) ||
      part.output != null ||
      part.result != null ||
      part.error != null;

    if (!prev.started && (looksRunning || looksDone)) {
      // Prefer args.command for bash-like tools so UI shows the command string.
      const command = commandFromArgs(toolName, args);
      const startedArgs =
        isBashLike(toolName) && command && !args.command ? { ...args, command } : args;
      events.push(
        makeEvent("tool.started", {
          ...base,
          toolName,
          args: startedArgs,
          toolId,
        })
      );
      prev.started = true;
    }

    if (
      !prev.finished &&
      looksDone &&
      status !== "running" &&
      status !== "in_progress" &&
      status !== "pending" &&
      status !== "partial"
    ) {
      const result = toolResultFromItem(part);
      const reportedExitCode = exitCodeFromItem(part);
      const outcome = classifyShellOutcome(part, { toolName, args });
      const command = commandFromArgs(toolName, args);
      const finishedArgs =
        isBashLike(toolName) && command && !args.command ? { ...args, command } : args;
      events.push(
        makeEvent("tool.finished", {
          ...base,
          toolName,
          args: finishedArgs,
          result,
          status: outcome.failed ? "error" : "ok",
          toolId,
          failureSource: outcome.failureSource,
          failureReason: outcome.failureReason,
          ...(isBashLike(toolName)
            ? {
                output: typeof result === "string" ? result : summarizeResult(result),
                exitCode: outcome.failed && reportedExitCode === 0 ? null : outcome.exitCode,
              }
            : {}),
        })
      );
      prev.finished = true;
    }

    toolStates.set(toolId, prev);
    return events;
  }

  function maybeRunStarted(base, sessionId) {
    if (emittedRunStarted) return [];
    emittedRunStarted = true;
    return [
      makeEvent("run.started", {
        ...base,
        sessionId: sessionId || "",
        provider: cli.providerId,
        model: cli.model || "",
      }),
    ];
  }

  function progressForStep(base, stepNumber) {
    const step = stepNumber == null ? lastStep + 1 : stepNumber;
    if (step === lastStep) return [];
    lastStep = step;
    const label = `第 ${step} 步`;
    return [
      makeEvent("progress.update", {
        ...base,
        items: [{ text: label, done: false, step }],
      }),
    ];
  }

  return {
    extractSessionId(event) {
      return sessionIdFromEvent(event);
    },
    transform(event, ctx) {
      const base = {
        agent: ctx.agent,
        invocationId: ctx.invocationId,
      };
      if (!event || typeof event !== "object") return [];

      if (event.type === "error") {
        const error = event.error;
        const message =
          typeof error === "string"
            ? error
            : error?.data?.message || error?.message || "OpenCode generation failed.";
        return [makeEvent("stderr", { ...base, text: message })];
      }

      const part = normalizePart(event);
      const sessionId = sessionIdFromEvent(event);

      // Thinking / reasoning (requires `opencode run --thinking` on the CLI).
      if (
        event.type === "reasoning" ||
        event.type === "thinking" ||
        (part && isReasoningPartType(part.type))
      ) {
        const thinkingPart =
          part && isReasoningPartType(part.type)
            ? part
            : {
                type: event.type || "reasoning",
                id: (part && part.id) || event.id || "_reasoning",
                text: reasoningTextFromPart(part) || reasoningTextFromPart(event),
              };
        const thinking = thinkingEventsFromPart(thinkingPart, base);
        if (thinking.length) {
          return [...maybeRunStarted(base, sessionId), ...thinking];
        }
      }

      if (event.type === "message.part.updated" && part && part.type === "text") {
        const id = part.id || "_default";
        const next = typeof part.text === "string" ? part.text : "";
        const prev = parts.get(id) || "";
        parts.set(id, next);
        let textEvents = [];
        if (!next.startsWith(prev)) {
          textEvents = [makeEvent("text.delta", { ...base, text: next })];
        } else {
          const delta = next.slice(prev.length);
          textEvents = delta ? [makeEvent("text.delta", { ...base, text: delta })] : [];
        }
        if (!textEvents.length) return [];
        return [...maybeRunStarted(base, sessionId), ...textEvents];
      }

      if (event.type === "message.part.updated" && part && isReasoningPartType(part.type)) {
        const thinking = thinkingEventsFromPart(part, base);
        if (thinking.length) return [...maybeRunStarted(base, sessionId), ...thinking];
      }

      if (event.type === "message.part.updated" && part) {
        const toolEvents = toolEventsFromPart(part, base);
        if (toolEvents.length) return [...maybeRunStarted(base, sessionId), ...toolEvents];
      }

      // Current CLI (1.17+): type "tool_use", part.type "tool", often status already completed.
      // Older builds may emit tool / tool_call / tool.updated instead.
      if (
        event.type === "tool_use" ||
        event.type === "tool-use" ||
        event.type === "tool" ||
        event.type === "tool_call" ||
        event.type === "tool.updated"
      ) {
        const toolPart = part || event;
        const toolEvents = toolEventsFromPart(
          {
            ...toolPart,
            type: toolPart.type || "tool",
            tool: toolPart.tool || toolPart.name,
            callID: toolPart.callID || toolPart.callId || toolPart.call_id,
          },
          base
        );
        if (toolEvents.length) return [...maybeRunStarted(base, sessionId), ...toolEvents];
      }

      if (event.type === "session.updated") {
        return maybeRunStarted(base, sessionId);
      }

      if (event.type === "step_start" || event.type === "step.start" || event.type === "loop") {
        const stepNumber = extractStepNumber(event, part);
        const out = [];
        out.push(...maybeRunStarted(base, sessionId));
        out.push(...progressForStep(base, stepNumber));
        return out;
      }

      if (
        event.type === "step_finish" ||
        event.type === "step.finish" ||
        event.type === "step-finish"
      ) {
        const reason = (part && part.reason) || event.reason || "";
        const label =
          reason === "tool-calls"
            ? "步骤完成（已调用工具）"
            : reason === "stop"
              ? "步骤完成"
              : reason
                ? `步骤完成: ${reason}`
                : "步骤完成";
        const out = [];
        out.push(...maybeRunStarted(base, sessionId));
        out.push(
          makeEvent("progress.update", {
            ...base,
            items: [{ text: label, done: true, reason }],
          })
        );
        const rawUsage =
          part && part.tokens
            ? { ...part.tokens, ...(part.cost !== undefined ? { cost: part.cost } : {}) }
            : event.tokens
              ? { ...event.tokens, ...(event.cost !== undefined ? { cost: event.cost } : {}) }
              : null;
        const usage = makeUsageEvent(base, rawUsage, {
          scope: "step",
          mode: "delta",
          cachedInputMode: "additional",
        });
        if (usage) out.push(usage);
        return out;
      }

      // part.type === "step-start" nested under other envelopes
      if (part && (part.type === "step-start" || part.type === "step_start")) {
        const stepNumber = extractStepNumber(event, part);
        const out = [];
        out.push(...maybeRunStarted(base, sessionId));
        out.push(...progressForStep(base, stepNumber));
        return out;
      }

      if (event.type === "assistant") {
        const content =
          event.message && Array.isArray(event.message.content) ? event.message.content : [];
        const text = content
          .filter((item) => item.type === "text" && typeof item.text === "string")
          .map((item) => item.text)
          .join("");
        if (!text) return [];
        return [...maybeRunStarted(base, sessionId), makeEvent("text.delta", { ...base, text })];
      }

      // Current CLI: top-level type "text" with part.type "text" and full part.text.
      if (event.type === "text" && part && part.type === "text" && typeof part.text === "string") {
        return [
          ...maybeRunStarted(base, sessionId),
          makeEvent("text.delta", {
            ...base,
            text: part.text,
          }),
        ];
      }

      const silentTypes = new Set([
        "message.part.updated",
        "step_start",
        "step.start",
        "step_finish",
        "step.finish",
        "step-finish",
        "loop",
        "session.updated",
        "assistant",
        "text",
        "reasoning",
        "thinking",
        "tool_use",
        "tool-use",
        "tool",
        "tool_call",
        "tool.updated",
      ]);
      if (event && event.type && !silentTypes.has(String(event.type))) {
        return [
          makeEvent("diagnostic", {
            ...base,
            code: "unmapped_event",
            rawType: String(event.type),
            message: "OpenCode event type not mapped to canonical protocol",
          }),
        ];
      }
      return [];
    },
  };
}

const OPENCODE_GO_MODEL_PREFIX = "opencode-go/";

function buildOpencodeEnvironment(_options = {}, env = process.env) {
  return {
    OPENCODE_CONFIG_CONTENT: createOpencodeShiftContextConfig(env.OPENCODE_CONFIG_CONTENT),
  };
}

function resolveOpencodeCommand() {
  if (process.platform !== "win32") return "opencode";
  const pathEntries = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const command = path.join(entry, "node_modules", "opencode-ai", "bin", "opencode.exe");
    if (fs.existsSync(command)) return command;
  }
  return "opencode.exe";
}

const opencodeProvider = {
  id: "opencode",
  capabilities: {
    resume: true,
    thinking: true,
    tools: true,
    usage: true,
    reasoning: "toggle",
  },
  // All OpenCode-backed models share this adapter; --model / --variant change.
  allowedProviderOptions: ["thinking", "modelPrefix", "autoApprove", "variant"],
  createRuntime: createOpencodeRuntime,
  resolveProxy,
  buildEnvironment: buildOpencodeEnvironment,
  buildInvocation(config, prompt) {
    const providerOptions = config.providerOptions || {};
    const args = ["run", "--format", "json"];
    // Required for thinking.delta from `reasoning` events (CLI 1.17+).
    if (providerOptions.thinking !== false) args.push("--thinking");
    // Headless: auto-approve tools that are not denied (otherwise may hang).
    if (providerOptions.autoApprove !== false) args.push("--auto");
    if (config.model) {
      const modelPrefix = providerOptions.modelPrefix ?? OPENCODE_GO_MODEL_PREFIX;
      const fullModel = config.model.startsWith(OPENCODE_GO_MODEL_PREFIX)
        ? config.model
        : `${modelPrefix}${config.model}`;
      args.push("--model", fullModel);
    }
    // Provider-specific reasoning effort (DeepSeek: low|high|max).
    const variant =
      (providerOptions.variant && String(providerOptions.variant).trim()) ||
      (config.reasoningEffort && String(config.reasoningEffort).trim()) ||
      "";
    if (variant) args.push("--variant", variant);
    if (config.resumeSessionId) args.push("--session", config.resumeSessionId);
    args.push(prompt);
    return { command: resolveOpencodeCommand(), args };
  },
};

module.exports = {
  createOpencodeRuntime,
  opencodeProvider,
  OPENCODE_GO_MODEL_PREFIX,
  resolveOpencodeCommand,
  normalizeToolArgs,
  sessionIdFromEvent,
  buildOpencodeEnvironment,
};
