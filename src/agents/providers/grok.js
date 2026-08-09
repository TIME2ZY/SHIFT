const { makeEvent } = require("../event-protocol");
const { makeUsageEvent } = require("../usage");
const fs = require("node:fs");
const path = require("node:path");
const { firstNonEmpty, resolveProxy } = require("../proxy");

/**
 * Grok Build CLI provider.
 *
 * Child process is the local `grok` binary (same pattern as codex / opencode):
 *   grok -p "..." --output-format streaming-json -m grok-4.5 \
 *     --reasoning-effort high --always-approve ...
 *   (--no-subagents only when providerOptions.noSubagents === true)
 *
 * Official / observed streaming-json (headless projector) event types:
 *   { "type": "thought", "data": "..." }   // often 1 word / few chars each
 *   { "type": "text", "data": "..." }
 *   { "type": "end", "stopReason", "sessionId", "requestId", "usage", "num_turns", ... }
 *   { "type": "error", "message": "..." }
 * Plus rare edge types (max_turns_reached, auto_compact_*, …).
 *
 * Tools run inside the CLI agent loop (local write/shell/etc.) but are NOT
 * emitted on streaming-json stdout — so capabilities.tools is false. File
 * side-effects are visible via session worktree git status/diff, not tool.*.
 * end.usage maps to the platform-wide usage.update protocol.
 *
 * Without coalescing, a short reply with high reasoning can emit 200+ NDJSON
 * lines → 200+ SSE/agent-events. We batch consecutive thought/text chunks.
 */

/** Flush thinking when buffered length reaches this many characters. */
const THINKING_FLUSH_CHARS = 80;
/** Flush assistant text a bit more eagerly for responsive UI. */
const TEXT_FLUSH_CHARS = 40;
const SUPPORTED_GROK_EFFORTS = new Set(["low", "medium", "high"]);

function createGrokRuntime(cli) {
  let emittedRunStarted = false;
  let thinkingBuf = "";
  let textBuf = "";

  function eventText(event) {
    if (typeof event.data === "string") return event.data;
    if (typeof event.text === "string") return event.text;
    if (typeof event.delta === "string") return event.delta;
    return "";
  }

  return {
    extractSessionId(event) {
      if (!event || typeof event !== "object") return "";
      if (event.type === "end" && typeof event.sessionId === "string" && event.sessionId) {
        return event.sessionId;
      }
      if (typeof event.sessionId === "string" && event.sessionId) {
        return event.sessionId;
      }
      if (event.type === "session" && typeof event.id === "string") {
        return event.id;
      }
      return "";
    },
    transform(event, ctx) {
      const base = {
        agent: ctx.agent,
        invocationId: ctx.invocationId,
      };
      if (!event || typeof event !== "object") return [];

      const out = [];

      const ensureStarted = (sessionId) => {
        if (emittedRunStarted) return;
        emittedRunStarted = true;
        out.push(
          makeEvent("run.started", {
            ...base,
            sessionId: sessionId || "",
            provider: "grok",
            model: (cli && cli.model) || "grok-4.5",
          })
        );
      };

      const flushThinking = (force = false) => {
        if (!thinkingBuf) return;
        if (!force && thinkingBuf.length < THINKING_FLUSH_CHARS) return;
        out.push(makeEvent("thinking.delta", { ...base, text: thinkingBuf }));
        thinkingBuf = "";
      };

      const flushText = (force = false) => {
        if (!textBuf) return;
        if (!force && textBuf.length < TEXT_FLUSH_CHARS) return;
        out.push(makeEvent("text.delta", { ...base, text: textBuf }));
        textBuf = "";
      };

      const flushAll = () => {
        flushThinking(true);
        flushText(true);
      };

      switch (event.type) {
        case "thought":
        case "thinking":
        case "reasoning": {
          ensureStarted(event.sessionId);
          // Switching stream kind: emit pending assistant text first.
          flushText(true);
          const text = eventText(event);
          if (text) {
            thinkingBuf += text;
            flushThinking(false);
          }
          return out;
        }

        case "text":
        case "message":
        case "assistant": {
          ensureStarted(event.sessionId);
          // Leaving thought stream: emit pending thinking first.
          flushThinking(true);
          const text = eventText(event);
          if (text) {
            textBuf += text;
            flushText(false);
          }
          return out;
        }

        case "end":
        case "done": {
          ensureStarted(event.sessionId);
          flushAll();
          const usage = makeUsageEvent(base, event.usage, {
            scope: "run",
            mode: "cumulative",
            cachedInputMode: "additional",
          });
          if (usage) out.push(usage);
          return out;
        }

        case "error": {
          ensureStarted();
          flushAll();
          const message = event.message || event.data || event.error || "Grok CLI error";
          out.push(makeEvent("run.failed", { ...base, error: String(message) }));
          return out;
        }

        // Forward-compat only: current Grok headless streaming-json does not
        // emit tool events (tools execute inside the CLI, invisible on stdout).
        case "tool":
        case "tool_use":
        case "tool_call": {
          ensureStarted(event.sessionId);
          flushAll();
          const toolName =
            String(
              event.name || event.tool || event.toolName || event.tool_name || "tool"
            ).trim() || "tool";
          const toolId = String(
            event.id || event.toolId || event.callID || event.call_id || toolName
          );
          const args =
            (event.input && typeof event.input === "object" && event.input) ||
            (event.arguments && typeof event.arguments === "object" && event.arguments) ||
            (event.args && typeof event.args === "object" && event.args) ||
            {};
          out.push(
            makeEvent("tool.started", {
              ...base,
              toolName,
              toolId,
              args,
            })
          );
          return out;
        }

        case "tool_result":
        case "tool_end":
        case "tool.finished": {
          ensureStarted(event.sessionId);
          flushAll();
          const toolName =
            String(
              event.name || event.tool || event.toolName || event.tool_name || "tool"
            ).trim() || "tool";
          const toolId = String(
            event.id || event.toolId || event.callID || event.call_id || toolName
          );
          const failed =
            event.status === "error" ||
            event.status === "failed" ||
            event.is_error === true ||
            Boolean(event.error);
          const result =
            event.result !== undefined
              ? event.result
              : event.output !== undefined
                ? event.output
                : event.data !== undefined
                  ? event.data
                  : event.error || null;
          out.push(
            makeEvent("tool.finished", {
              ...base,
              toolName,
              toolId,
              result,
              status: failed ? "error" : "ok",
            })
          );
          return out;
        }

        default: {
          ensureStarted(event.sessionId);
          if (event.type) {
            out.push(
              makeEvent("diagnostic", {
                ...base,
                code: "unmapped_event",
                rawType: String(event.type),
                message: "Grok event type not mapped to canonical protocol",
              })
            );
          }
          return out;
        }
      }
    },
    finish(ctx) {
      const base = {
        agent: ctx.agent,
        invocationId: ctx.invocationId,
      };
      const out = [];
      if (thinkingBuf) {
        out.push(makeEvent("thinking.delta", { ...base, text: thinkingBuf }));
        thinkingBuf = "";
      }
      if (textBuf) {
        out.push(makeEvent("text.delta", { ...base, text: textBuf }));
        textBuf = "";
      }
      return out;
    },
  };
}

function resolveGrokCommand() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const candidates = [];
  if (home) {
    candidates.push(
      path.join(home, ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok")
    );
  }
  for (const entry of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(entry, process.platform === "win32" ? "grok.exe" : "grok"));
  }
  for (const command of candidates) {
    try {
      if (fs.existsSync(command)) return command;
    } catch {
      // Ignore inaccessible PATH entries.
    }
  }
  return process.platform === "win32" ? "grok.exe" : "grok";
}

const grokProvider = {
  id: "grok",
  capabilities: {
    resume: true,
    thinking: true,
    // Grok uses ACP by default; the retained streaming-json transport has no
    // tool/file events, but ACP exposes the full tool lifecycle.
    tools: true,
    usage: true,
    reasoning: "levels",
  },
  cliCapabilities: {
    resume: true,
    thinking: true,
    tools: false,
    usage: true,
    reasoning: "levels",
  },
  allowedProviderOptions: ["alwaysApprove", "autoUpdate", "proxy", "noSubagents"],
  createRuntime: createGrokRuntime,
  resolveProxy(options = {}, env = process.env) {
    const providerOptions = options.providerOptions || {};
    return firstNonEmpty(
      options.proxy,
      providerOptions.proxy,
      env.GROK_PROXY,
      env.INVOKE_GROK_PROXY,
      env.GROK_HTTP_PROXY,
      env.GROK_HTTPS_PROXY,
      resolveProxy({}, env)
    );
  },
  /**
   * Keep Grok-only proxy vars visible to nested tools even when the shared
   * HTTP(S)_PROXY injection comes from GROK_PROXY resolution.
   */
  buildEnvironment(_options = {}, env = process.env) {
    const patch = {};
    if (process.platform === "win32" && !env.HOME && env.USERPROFILE) {
      patch.HOME = env.USERPROFILE;
    }
    for (const key of ["GROK_PROXY", "INVOKE_GROK_PROXY", "GROK_HTTP_PROXY", "GROK_HTTPS_PROXY"]) {
      if (typeof env[key] === "string" && env[key].trim()) {
        patch[key] = env[key].trim();
      }
    }
    return patch;
  },
  diagnostics(options = {}) {
    if (options.proxy) return [];
    return [
      "[invoke-cli] no proxy for grok; if requests hang, set INVOKE_CLI_PROXY=http://127.0.0.1:7892 (all CLIs) or GROK_PROXY (Grok-only)",
    ];
  },
  validate(config) {
    const effort = config.reasoningEffort || "high";
    if (!SUPPORTED_GROK_EFFORTS.has(effort)) {
      throw new Error(
        `Unsupported Grok reasoning effort "${effort}". Supported: ${[
          ...SUPPORTED_GROK_EFFORTS,
        ].join(", ")}.`
      );
    }
  },
  buildInvocation(config, prompt) {
    const effort = config.reasoningEffort || "high";
    const providerOptions = config.providerOptions || {};
    const args = ["-p", prompt, "--output-format", "streaming-json"];
    if (providerOptions.alwaysApprove !== false) args.push("--always-approve");
    if (providerOptions.autoUpdate !== true) args.push("--no-auto-update");
    // Nested subagents are allowed by default (Grok strength). Opt out only when
    // providerOptions.noSubagents === true. Cross-agent work still uses @/handoff.
    if (providerOptions.noSubagents === true) args.push("--no-subagents");
    if (config.model) args.push("-m", config.model);
    if (effort) args.push("--reasoning-effort", effort);
    if (config.resumeSessionId) args.push("-r", config.resumeSessionId);
    return { command: resolveGrokCommand(), args };
  },
};

module.exports = {
  createGrokRuntime,
  THINKING_FLUSH_CHARS,
  TEXT_FLUSH_CHARS,
  SUPPORTED_GROK_EFFORTS,
  resolveGrokCommand,
  grokProvider,
};
