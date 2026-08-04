const { spawn } = require("node:child_process");
const { Readable, Writable } = require("node:stream");
const { createProviderRuntime } = require("./providers");

function preferredPermission(options = []) {
  return (
    options.find((option) => option.kind === "allow_always") ||
    options.find((option) => option.kind === "allow_once") ||
    options.find((option) => /^allow/i.test(String(option.kind || ""))) ||
    null
  );
}

function shouldLoadAcpSession(config, initialized) {
  return Boolean(
    config?.resumeSessionId &&
      initialized?.agentCapabilities?.loadSession === true
  );
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
    child.kill(signal);
    clearTimeout(killTimer);
    killTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
  };
  const activityTimer = setInterval(() => {
    if (Date.now() - lastActivity > timeoutMs) {
      terminate(`${command} ACP session timed out after ${timeoutMs}ms of no activity.`);
    }
  }, Math.max(100, Math.min(1000, Math.floor(timeoutMs / 2))));
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
    if (
      sessionId &&
      sessionId !== persistedSessionId &&
      typeof onSessionId === "function"
    ) {
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
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout)
    );
    let activeSessionId = "";
    const result = await acp
      .client({ name: "shift-console", version: "0.1.0" })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
        if (config.providerOptions?.alwaysApprove === false) {
          return { outcome: { outcome: "cancelled" } };
        }
        const selected = preferredPermission(params.options);
        if (!selected) return { outcome: { outcome: "cancelled" } };
        return {
          outcome: {
            outcome: "selected",
            optionId: selected.optionId,
          },
        };
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
            await ctx.request(acp.methods.agent.session.load, {
              sessionId: activeSessionId,
              cwd,
              mcpServers: [],
            });
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
          const created = await ctx.request(acp.methods.agent.session.new, {
            cwd,
            mcpServers: [],
          });
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
  shouldLoadAcpSession,
};
