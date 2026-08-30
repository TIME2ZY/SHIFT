const { spawn } = require("node:child_process");
const { Readable, Writable } = require("node:stream");
const { createProviderRuntime } = require("./providers");
const { killProcessTree } = require("./windows-runtime");

const ACP_READ_ONLY_TOOL_KINDS = new Set(["read", "search", "think", "fetch"]);
const ACP_MUTATING_TOOL_NAME_RE =
  /(?:^|[_-])(write|edit|delete|remove|move|rename|patch|bash|shell|terminal|execute|exec|run|command)(?:$|[_-])/i;

function preferredPermission(options = []) {
  return (
    options.find((option) => option.kind === "allow_always") ||
    options.find((option) => option.kind === "allow_once") ||
    options.find((option) => /^allow/i.test(String(option.kind || ""))) ||
    null
  );
}

function preferredOneShotPermission(options = []) {
  return (
    options.find((option) => option.kind === "allow_once") ||
    options.find((option) => /^allow_once$/i.test(String(option.kind || ""))) ||
    null
  );
}

function isAcpReadOnlyToolCall(toolCall = {}) {
  const kind = String(toolCall.kind || "other").toLowerCase();
  if (!ACP_READ_ONLY_TOOL_KINDS.has(kind)) return false;
  const name = String(toolCall.name || toolCall.title || "");
  if (ACP_MUTATING_TOOL_NAME_RE.test(name)) return false;
  const input =
    toolCall.rawInput && typeof toolCall.rawInput === "object" && !Array.isArray(toolCall.rawInput)
      ? toolCall.rawInput
      : {};
  return !["command", "commandLine", "command_line", "cmd", "script"].some(
    (field) => typeof input[field] === "string" && input[field].trim()
  );
}

function decideAcpPermission(params = {}, config = {}) {
  const toolCall = params.toolCall || {};
  const toolKind = String(toolCall.kind || "other").toLowerCase();
  const gate = config.executionGate || null;
  if (gate && gate.allowed !== true) {
    if (!isAcpReadOnlyToolCall(toolCall)) {
      return {
        allowed: false,
        reason: "implementation_plan_not_approved",
        toolKind,
        response: { outcome: { outcome: "cancelled" } },
      };
    }
    const selected = preferredOneShotPermission(params.options);
    if (!selected) {
      return {
        allowed: false,
        reason: "read_permission_unavailable",
        toolKind,
        response: { outcome: { outcome: "cancelled" } },
      };
    }
    return {
      allowed: true,
      reason: null,
      toolKind,
      response: { outcome: { outcome: "selected", optionId: selected.optionId } },
    };
  }

  if (config.providerOptions?.alwaysApprove === false) {
    return {
      allowed: false,
      reason: "provider_auto_approval_disabled",
      toolKind,
      response: { outcome: { outcome: "cancelled" } },
    };
  }
  const selected = preferredPermission(params.options);
  return selected
    ? {
        allowed: true,
        reason: null,
        toolKind,
        response: { outcome: { outcome: "selected", optionId: selected.optionId } },
      }
    : {
        allowed: false,
        reason: "allow_option_unavailable",
        toolKind,
        response: { outcome: { outcome: "cancelled" } },
      };
}

function shouldLoadAcpSession(config, initialized) {
  return Boolean(config?.resumeSessionId && initialized?.agentCapabilities?.loadSession === true);
}

function buildAcpSessionParams(cwd, mcpServers, sessionId = "") {
  return {
    ...(sessionId ? { sessionId } : {}),
    cwd,
    mcpServers,
  };
}

function loadAcpSdk() {
  return import("@agentclientprotocol/sdk");
}

async function invokeAcp({
  config,
  command,
  args,
  env,
  cwd = process.cwd(),
  mcpServers = [],
  eventContext,
  onEvent,
  onRawEvent,
  onSessionId,
  spawnFn = spawn,
  timeoutMs = 30 * 60 * 1000,
  killGraceMs = 5000,
}) {
  const acp = await loadAcpSdk();
  const runtime = createProviderRuntime(config, { transport: "acp" });
  const child = spawnFn(command, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.setEncoding?.("utf8");
  child.stderr.on("data", (chunk) => process.stderr.write(String(chunk)));
  let lastActivity = Date.now();
  let terminationError = null;
  let killTimer;
  const markActivity = () => {
    lastActivity = Date.now();
  };
  child.stdout.on("data", markActivity);
  child.stderr.on("data", markActivity);
  const terminate = (message, signal = "SIGTERM") => {
    if (terminationError) return;
    terminationError = new Error(message);
    killProcessTree(child, signal);
    clearTimeout(killTimer);
    killTimer = setTimeout(() => killProcessTree(child, "SIGKILL"), killGraceMs);
  };
  const activityTimer = setInterval(
    () => {
      if (Date.now() - lastActivity > timeoutMs) {
        terminate(`${command} ACP session timed out after ${timeoutMs}ms of no activity.`);
      }
    },
    Math.max(100, Math.min(1000, Math.floor(timeoutMs / 2)))
  );
  const signalHandlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => terminate(`${command} ACP session received ${signal}.`, signal);
    process.once(signal, handler);
    signalHandlers.set(signal, handler);
  }
  const cleanup = () => {
    clearInterval(activityTimer);
    clearTimeout(killTimer);
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
  };

  let persistedSessionId = "";
  const emitRaw = (event) => {
    if (typeof onRawEvent === "function") onRawEvent(event);
    const sessionId = runtime.extractSessionId(event);
    if (sessionId && sessionId !== persistedSessionId && typeof onSessionId === "function") {
      persistedSessionId = sessionId;
      onSessionId(sessionId);
    }
    for (const canonical of runtime.transform(event, eventContext)) onEvent(canonical);
  };

  let childError = null;
  child.once("error", (error) => {
    childError = error;
  });

  try {
    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
    let activeSessionId = "";
    const result = await acp
      .client({ name: "shift-console", version: "0.1.0" })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
        const decision = decideAcpPermission(params, config);
        if (!decision.allowed) {
          emitRaw({
            type: "acp.permission_denied",
            sessionId: params.sessionId,
            toolCallId: params.toolCall?.toolCallId || null,
            toolKind: decision.toolKind,
            reason: decision.reason,
            planHash: config.executionGate?.planHash || null,
          });
        }
        return decision.response;
      })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        // session/load replays the previous transcript. It restores provider
        // context, but replayed events must not become output of this invocation.
        if (params?._meta?.isReplay === true) return;
        emitRaw({
          type: "acp.session_update",
          sessionId: params.sessionId,
          update: params.update,
        });
      })
      .connectWith(stream, async (ctx) => {
        const initialized = await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {
            fs: {
              readTextFile: false,
              writeTextFile: false,
            },
            terminal: false,
          },
          clientInfo: {
            name: "shift-console",
            version: "0.1.0",
          },
        });
        if (typeof onRawEvent === "function") {
          onRawEvent({ type: "acp.initialized", result: initialized });
        }

        let loaded = false;
        if (shouldLoadAcpSession(config, initialized)) {
          activeSessionId = config.resumeSessionId;
          try {
            await ctx.request(
              acp.methods.agent.session.load,
              buildAcpSessionParams(cwd, mcpServers, activeSessionId)
            );
            loaded = true;
          } catch (error) {
            activeSessionId = "";
            if (typeof onRawEvent === "function") {
              onRawEvent({
                type: "acp.session_load_failed",
                sessionId: config.resumeSessionId,
                error: error.message || String(error),
              });
            }
          }
        }

        if (!activeSessionId) {
          const created = await ctx.request(
            acp.methods.agent.session.new,
            buildAcpSessionParams(cwd, mcpServers)
          );
          activeSessionId = created.sessionId;
        }

        emitRaw({
          type: "acp.session_started",
          sessionId: activeSessionId,
          loaded,
        });
        return ctx.request(acp.methods.agent.session.prompt, {
          sessionId: activeSessionId,
          prompt: [{ type: "text", text: config.prompt }],
        });
      });
    emitRaw({
      type: "acp.prompt_result",
      sessionId: activeSessionId,
      result,
    });

    for (const event of runtime.finish(eventContext, {
      terminal: true,
      ok: true,
      exitCode: 0,
      signal: null,
      stopReason: result.stopReason,
    })) {
      onEvent(event);
    }
    child.kill();
    cleanup();
    return { child, result };
  } catch (error) {
    const reason = terminationError || childError || error;
    for (const event of runtime.finish(eventContext, {
      terminal: true,
      ok: false,
      exitCode: null,
      signal: null,
      error: reason.message || String(reason),
    })) {
      onEvent(event);
    }
    child.kill();
    cleanup();
    throw reason;
  }
}

module.exports = {
  invokeAcp,
  loadAcpSdk,
  preferredPermission,
  preferredOneShotPermission,
  decideAcpPermission,
  isAcpReadOnlyToolCall,
  ACP_READ_ONLY_TOOL_KINDS,
  shouldLoadAcpSession,
  buildAcpSessionParams,
};
