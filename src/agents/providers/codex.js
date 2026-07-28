const fs = require("node:fs");
const path = require("node:path");
const { makeEvent } = require("../event-protocol");
const { makeUsageEvent } = require("../usage");
const { resolveProxy } = require("../proxy");
const {
  toolNameFromItem,
  toolArgsFromItem,
  toolResultFromItem,
  isFailedItem,
  toolItemId,
} = require("../tool-classification");

const CODEX_PACKAGE_ENTRY = path.join("node_modules", "@openai", "codex", "bin", "codex.js");

/**
 * Resolve Codex without relying on a shell. On Windows, npm exposes codex.cmd,
 * which child_process.spawn cannot execute directly with shell:false. Prefer a
 * native executable when present; otherwise launch the npm package entry with
 * the same Node executable that is running SHIFT.
 */
function resolveCodexLauncher(
  env = process.env,
  {
    platform = process.platform,
    existsSync = fs.existsSync,
    nodePath = process.execPath,
  } = {}
) {
  const override = String(env.INVOKE_CODEX_PATH || env.CODEX_PATH || "").trim();
  if (override) {
    return launcherForCodexPath(override, { platform, existsSync, nodePath });
  }
  if (platform !== "win32") return { command: "codex", argsPrefix: [] };

  const pathValue = String(env.Path || env.PATH || "");
  const pathDirs = pathValue
    .split(";")
    .map((item) => item.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
  const appDataNpm = env.APPDATA ? path.win32.join(env.APPDATA, "npm") : "";
  if (appDataNpm && !pathDirs.some((item) => sameWindowsPath(item, appDataNpm))) {
    pathDirs.push(appDataNpm);
  }

  for (const directory of pathDirs) {
    const nativeCommand = path.win32.join(directory, "codex.exe");
    if (existsSync(nativeCommand)) return { command: nativeCommand, argsPrefix: [] };

    const cmdShim = path.win32.join(directory, "codex.cmd");
    if (!existsSync(cmdShim)) continue;
    const packageEntry = path.win32.join(directory, CODEX_PACKAGE_ENTRY);
    if (existsSync(packageEntry)) {
      return { command: nodePath, argsPrefix: [packageEntry] };
    }
  }

  // Preserve the normal lookup on platforms/installations that provide a real
  // executable elsewhere. A start failure will retain the provider's standard
  // diagnostic instead of silently invoking a command shell.
  return { command: "codex", argsPrefix: [] };
}

function launcherForCodexPath(candidate, { platform, existsSync, nodePath }) {
  if (/\.js$/i.test(candidate)) return { command: nodePath, argsPrefix: [candidate] };
  if (platform === "win32" && /\.cmd$/i.test(candidate)) {
    const packageEntry = path.win32.join(path.win32.dirname(candidate), CODEX_PACKAGE_ENTRY);
    if (existsSync(packageEntry)) {
      return { command: nodePath, argsPrefix: [packageEntry] };
    }
  }
  return { command: candidate, argsPrefix: [] };
}

function sameWindowsPath(left, right) {
  return path.win32.resolve(left).toLowerCase() === path.win32.resolve(right).toLowerCase();
}

function buildCodexEnvironment(_options = {}, env = process.env) {
  const codexHome = String(env.INVOKE_CODEX_HOME || "").trim();
  return codexHome ? { CODEX_HOME: codexHome } : {};
}

function codexDiagnostic(code, severity, message, options = {}) {
  return {
    code,
    severity,
    message,
    fingerprint: `codex:${code}`,
    affectsRun: false,
    visibility: severity === "debug" ? "hidden" : "details",
    retryable: false,
    ...options,
  };
}

function classifyCodexStderr(line) {
  const text = String(line || "").trim();
  if (!text) return codexDiagnostic("empty_stderr", "debug", "", { visibility: "hidden" });

  if (
    /\b(?:401 Unauthorized|token_invalidated|refresh_token_invalidated)\b/i.test(text) ||
    /(?:Please log in again|access token could not be refreshed|session has ended)/i.test(text)
  ) {
    return codexDiagnostic(
      "authentication_invalidated",
      "error",
      "Codex CLI 登录已失效，请重新登录后重试。",
      {
        affectsRun: true,
        visibility: "inline",
        captureContinuation: true,
      }
    );
  }

  if (text === "Reading additional input from stdin...") {
    return codexDiagnostic("stdin_notice", "debug", text, { visibility: "hidden" });
  }
  if (
    /\bWARN codex_core_plugins::manifest: ignoring\b/.test(text) ||
    /\bWARN codex_core_skills::loader: ignoring\b/.test(text)
  ) {
    return codexDiagnostic(
      "duplicate_extension_ignored",
      "debug",
      "Codex 忽略了重复的插件或技能定义。",
      { visibility: "hidden" }
    );
  }
  if (/codex_core::shell_snapshot: Failed to create shell snapshot/i.test(text)) {
    return codexDiagnostic(
      "shell_snapshot_failed",
      "diagnostic",
      "PowerShell 环境快照创建失败，不影响当前回答。",
      { retryable: true }
    );
  }
  if (
    /failed to (?:load models cache|renew cache TTL)/i.test(text) ||
    /missing field [`'"]?supports_reasoning_summaries/i.test(text)
  ) {
    return codexDiagnostic(
      "model_cache_incompatible",
      "diagnostic",
      "Codex 模型缓存与当前 CLI 版本不兼容，将由 CLI 自动刷新。",
      { retryable: true }
    );
  }
  if (
    /failed to refresh available models:.*timeout waiting for child process to exit/i.test(text)
  ) {
    return codexDiagnostic(
      "model_catalog_refresh_timeout",
      "diagnostic",
      "Codex 模型列表刷新超时，不影响当前回答。",
      { retryable: true }
    );
  }
  if (/codex_api::endpoint::responses_websocket: failed to connect/i.test(text)) {
    return codexDiagnostic(
      "responses_websocket_failed",
      "warning",
      "Codex WebSocket 连接失败，CLI 可能自动回退到其他传输方式。",
      { retryable: true }
    );
  }
  if (
    /rmcp::transport::worker/i.test(text) &&
    /(?:worker quit|request failed|Transport channel closed|UnexpectedServerResponse)/i.test(text)
  ) {
    return codexDiagnostic("mcp_transport_failed", "warning", "Codex 的可选 MCP 连接不可用。", {
      retryable: true,
      captureContinuation: true,
    });
  }
  if (/codex_core::tools::router: error=Exit code:/i.test(text)) {
    return codexDiagnostic(
      "tool_router_error",
      "diagnostic",
      "Codex 的一个工具命令执行失败，详情已记录在工具结果中。",
      { captureContinuation: true }
    );
  }
  if (/failed to refresh available models:/i.test(text)) {
    return codexDiagnostic("model_catalog_refresh_failed", "warning", "Codex 模型列表刷新失败。", {
      retryable: true,
    });
  }
  return null;
}

function createCodexRuntime(cli) {
  function fileChangeEvents(base, item) {
    const changes = item && Array.isArray(item.changes) ? item.changes : [];
    return changes
      .filter((change) => change && typeof change.path === "string")
      .map((change) =>
        makeEvent("file.changed", {
          ...base,
          path: change.path,
          changeType: change.kind || "",
        })
      );
  }

  function isToolLikeItem(item) {
    if (!item || typeof item !== "object") return false;
    const type = String(item.type || "").toLowerCase();
    return (
      type === "mcp_tool_call" ||
      type === "mcptoolcall" ||
      type === "function_call" ||
      type === "functioncall" ||
      type === "tool_call" ||
      type === "toolcall" ||
      type === "web_search" ||
      type === "websearch" ||
      Boolean(toolNameFromItem(item))
    );
  }

  function reasoningTextFromItem(item) {
    if (!item || typeof item !== "object") return "";
    if (typeof item.text === "string" && item.text) return item.text;
    if (typeof item.content === "string" && item.content) return item.content;
    if (typeof item.summary === "string" && item.summary) return item.summary;
    if (Array.isArray(item.summary) && item.summary.length) {
      return item.summary
        .map((part) => {
          if (typeof part === "string") return part;
          if (part && typeof part.text === "string") return part.text;
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
    return "";
  }

  function toolLifecycleEvents(base, item, phase) {
    if (!isToolLikeItem(item)) return [];
    const toolName = toolNameFromItem(item) || String(item.type || "tool");
    const args = toolArgsFromItem(item);
    const toolId = toolItemId(item, toolName);

    if (phase === "started") {
      return [
        makeEvent("tool.started", {
          ...base,
          toolName,
          args,
          toolId,
        }),
      ];
    }

    const result = toolResultFromItem(item);
    const failed = isFailedItem(item);
    return [
      makeEvent("tool.finished", {
        ...base,
        toolName,
        result,
        status: failed ? "error" : "ok",
        toolId,
      }),
    ];
  }

  return {
    extractSessionId(event) {
      return event && event.type === "thread.started" && typeof event.thread_id === "string"
        ? event.thread_id
        : "";
    },
    transform(event, ctx) {
      const base = {
        agent: ctx.agent,
        invocationId: ctx.invocationId,
      };

      if (event.type === "thread.started") {
        return [
          makeEvent("run.started", {
            ...base,
            sessionId: event.thread_id || "",
            provider: cli.providerId,
            model: cli.model || "",
          }),
        ];
      }

      if (event.type === "error" && typeof event.message === "string") {
        return [
          makeEvent("stderr", {
            ...base,
            text: event.message,
          }),
        ];
      }

      if (event.type === "item.started" && event.item && event.item.type === "command_execution") {
        const command = event.item.command || "";
        const toolId = toolItemId(event.item, "command_execution");
        return [
          makeEvent("tool.started", {
            ...base,
            toolName: "command_execution",
            toolId,
            args: { command },
          }),
        ];
      }

      if (
        event.type === "item.completed" &&
        event.item &&
        event.item.type === "command_execution"
      ) {
        const command = event.item.command || "";
        const toolId = toolItemId(event.item, "command_execution");
        const exitCode = event.item.exit_code;
        const failed = typeof exitCode === "number" ? exitCode !== 0 : isFailedItem(event.item);
        return [
          makeEvent("tool.finished", {
            ...base,
            toolName: "command_execution",
            toolId,
            args: { command },
            output: event.item.aggregated_output || "",
            exitCode,
            status: failed ? "error" : "ok",
          }),
        ];
      }

      if (
        (event.type === "item.started" || event.type === "item.completed") &&
        event.item &&
        event.item.type === "file_change"
      ) {
        return fileChangeEvents(base, event.item);
      }

      if (
        event.type === "item.completed" &&
        event.item &&
        event.item.type === "error" &&
        typeof event.item.message === "string"
      ) {
        return [
          makeEvent("stderr", {
            ...base,
            text: event.item.message,
          }),
        ];
      }

      // Reasoning / thinking (Codex item.type === "reasoning")
      if (
        (event.type === "item.completed" ||
          event.type === "item.started" ||
          event.type === "item.updated") &&
        event.item &&
        String(event.item.type || "").toLowerCase() === "reasoning"
      ) {
        const text = reasoningTextFromItem(event.item);
        if (!text) return [];
        return [makeEvent("thinking.delta", { ...base, text })];
      }

      if (
        event.type === "item.completed" &&
        event.item &&
        event.item.type === "agent_message" &&
        typeof event.item.text === "string"
      ) {
        return [
          makeEvent("text.delta", {
            ...base,
            text: event.item.text,
          }),
        ];
      }

      if (event.type === "assistant") {
        const content =
          event.message && Array.isArray(event.message.content) ? event.message.content : [];
        const text = content
          .filter((item) => item.type === "text" && typeof item.text === "string")
          .map((item) => item.text)
          .join("");
        return text ? [makeEvent("text.delta", { ...base, text })] : [];
      }

      if (event.type === "turn.completed" && event.usage) {
        const usage = makeUsageEvent(base, event.usage, {
          scope: "turn",
          mode: "cumulative",
        });
        return usage ? [usage] : [];
      }

      const content = event.content || (event.properties && event.properties.content);
      if (content && content.type === "text" && typeof content.text === "string") {
        return [
          makeEvent("text.delta", {
            ...base,
            text: content.text,
          }),
        ];
      }

      if (event.type === "item.completed" && event.item && event.item.type === "todo_list") {
        return [
          makeEvent("progress.update", {
            ...base,
            items: Array.isArray(event.item.items) ? event.item.items : [],
          }),
        ];
      }

      if (event.type === "item.started" && event.item) {
        const toolEvents = toolLifecycleEvents(base, event.item, "started");
        if (toolEvents.length) return toolEvents;
      }

      if (event.type === "item.completed" && event.item) {
        const toolEvents = toolLifecycleEvents(base, event.item, "completed");
        if (toolEvents.length) return toolEvents;
      }

      // Intentionally silent provider noise (partial updates, etc.).
      const silentTypes = new Set([
        "item.updated",
        "item.started",
        "item.completed",
        "turn.started",
        "turn.completed",
        "task_started",
        "task_complete",
      ]);
      if (event && event.type && !silentTypes.has(String(event.type))) {
        return [
          makeEvent("diagnostic", {
            ...base,
            code: "unmapped_event",
            rawType: String(event.type),
            message: "Codex event type not mapped to canonical protocol",
          }),
        ];
      }
      return [];
    },
  };
}

const codexProvider = {
  id: "codex",
  capabilities: {
    resume: true,
    thinking: true,
    tools: true,
    usage: true,
    reasoning: "levels",
  },
  allowedProviderOptions: ["sandbox", "approvalPolicy"],
  createRuntime: createCodexRuntime,
  classifyStderr: classifyCodexStderr,
  resolveProxy,
  buildEnvironment: buildCodexEnvironment,
  buildInvocation(config, prompt) {
    const providerOptions = config.providerOptions || {};
    const launcher = resolveCodexLauncher();
    const args = [
      ...launcher.argsPrefix,
      "-s",
      providerOptions.sandbox || "danger-full-access",
      "-a",
      providerOptions.approvalPolicy || "never",
    ];
    if (config.reasoningEffort) {
      args.push("-c", `model_reasoning_effort="${config.reasoningEffort}"`);
    }
    if (config.model) args.push("-m", config.model);
    if (config.resumeSessionId) {
      args.push("exec", "resume", "--json", config.resumeSessionId, prompt);
    } else {
      args.push("exec", "--json", prompt);
    }
    return { command: launcher.command, args };
  },
};

module.exports = {
  buildCodexEnvironment,
  classifyCodexStderr,
  createCodexRuntime,
  resolveCodexLauncher,
  codexProvider,
};
