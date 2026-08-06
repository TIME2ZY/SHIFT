const fs = require("node:fs");
const path = require("node:path");
const { makeEvent } = require("../event-protocol");
const { makeUsageEvent } = require("../usage");
const { resolveProxy } = require("../proxy");

/**
 * Google Antigravity CLI provider (`agy`).
 *
 * Local binary (Windows): `%LOCALAPPDATA%\agy\bin\agy.exe` (also on PATH as `agy`).
 *
 * Headless (verified agy 1.1.3):
 *   agy -p "..." --model "Gemini 3.6 Flash (High)" \
 *     --dangerously-skip-permissions --mode plan \
 *     --output-format stream-json
 *
 * `--output-format` is real but omitted from `agy --help`. Values:
 *   text | json | stream-json  (default for this adapter: stream-json)
 *
 * stream-json NDJSON (model-agnostic envelope):
 *   init         → run.started + conversation_id
 *   step_update  → text.delta | tool.* | progress.update | diagnostic
 *   result       → session id; response only if no text was streamed
 *
 * Tool steps expose tool_name + tool_info.parameters/output/error.
 * Thinking: usage may include thinking_tokens; TUI shows "Thought for…";
 * toolCall.thinkingSignature is an opaque blob — NOT mapped to thinking.delta.
 * capabilities.thinking stays false until a real reasoning text stream exists.
 *
 * Available models (agy models):
 *   Gemini 3.6 Flash (Low|Medium|High)
 *   Gemini 3.5 Flash (Low|Medium|High)
 *   Gemini 3.1 Pro (Low|High)
 *   Claude Sonnet 4.6 (Thinking) / Claude Opus 4.6 (Thinking)
 *   GPT-OSS 120B (Medium)
 */

const SUPPORTED_EFFORTS = new Set(["low", "medium", "high"]);
const SUPPORTED_MODES = new Set(["accept-edits", "plan"]);
const SUPPORTED_OUTPUT_FORMATS = new Set(["text", "json", "stream-json"]);

/** Catalog model id → CLI family label prefix. */
const MODEL_FAMILY = {
  "gemini-3.6-flash": "Gemini 3.6 Flash",
  "gemini-3.5-flash": "Gemini 3.5 Flash",
  "gemini-3.1-pro": "Gemini 3.1 Pro",
};

/**
 * Map catalog model + reasoningEffort to the Antigravity CLI --model string.
 * Effort is embedded in the model label (not a separate flag).
 */
function resolveAgyModelLabel(modelId, reasoningEffort = "high") {
  const raw = String(modelId || "").trim();
  if (!raw) return "Gemini 3.6 Flash (High)";
  // Already a full CLI label, e.g. "Gemini 3.6 Flash (High)"
  if (/\(.*\)\s*$/.test(raw)) return raw;

  const family = MODEL_FAMILY[raw] || raw;
  const effortRaw = String(reasoningEffort || "high").toLowerCase();
  const effort = SUPPORTED_EFFORTS.has(effortRaw) ? effortRaw : "high";
  const effortLabel = effort.charAt(0).toUpperCase() + effort.slice(1);
  return `${family} (${effortLabel})`;
}

function resolveAgyCommand(env = process.env) {
  if (env.AGY_PATH && String(env.AGY_PATH).trim()) return String(env.AGY_PATH).trim();
  if (env.ANTIGRAVITY_PATH && String(env.ANTIGRAVITY_PATH).trim()) {
    return String(env.ANTIGRAVITY_PATH).trim();
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || "";
    if (local) {
      const candidate = path.join(local, "agy", "bin", "agy.exe");
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return "agy";
}

/**
 * Antigravity's Windows stream-json writer can split model text at invalid
 * UTF-8 boundaries, replacing isolated Chinese bytes with U+FFFD before Node
 * receives them. The buffered json format preserves the final response and
 * conversation id without passing through that incremental writer.
 */
function resolveAgyOutputFormat(
  providerOptions = {},
  env = process.env,
  platform = process.platform
) {
  const explicit = providerOptions.outputFormat
    ? String(providerOptions.outputFormat)
    : String(env.AGY_OUTPUT_FORMAT || "").trim();
  if (explicit) {
    if (!SUPPORTED_OUTPUT_FORMATS.has(explicit)) {
      throw new Error(
        `Unsupported Antigravity outputFormat "${explicit}". Supported: ${[
          ...SUPPORTED_OUTPUT_FORMATS,
        ].join(", ")}.`
      );
    }
    return explicit;
  }
  return platform === "win32" ? "json" : "stream-json";
}

function sessionIdFromEvent(event) {
  if (!event || typeof event !== "object") return "";
  if (typeof event.conversation_id === "string" && event.conversation_id) {
    return event.conversation_id;
  }
  if (typeof event.conversationId === "string" && event.conversationId) {
    return event.conversationId;
  }
  const step = event.step_update || event.stepUpdate;
  if (step && typeof step === "object") {
    if (typeof step.conversation_id === "string" && step.conversation_id) {
      return step.conversation_id;
    }
    if (typeof step.conversationId === "string" && step.conversationId) {
      return step.conversationId;
    }
  }
  const result = event.result;
  if (result && typeof result === "object") {
    if (typeof result.conversation_id === "string" && result.conversation_id) {
      return result.conversation_id;
    }
    if (typeof result.conversationId === "string" && result.conversationId) {
      return result.conversationId;
    }
  }
  return "";
}

/**
 * Normalize Antigravity tool parameters for UI toolDetailFromEvent.
 * CLI often uses PascalCase (DirectoryPath, CommandLine, …).
 */
function normalizeToolArgs(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return params || {};
  const next = { ...params };

  const pathLike =
    (typeof next.path === "string" && next.path) ||
    (typeof next.DirectoryPath === "string" && next.DirectoryPath) ||
    (typeof next.directoryPath === "string" && next.directoryPath) ||
    (typeof next.file === "string" && next.file) ||
    (typeof next.FilePath === "string" && next.FilePath) ||
    (typeof next.filePath === "string" && next.filePath) ||
    (typeof next.file_path === "string" && next.file_path) ||
    (typeof next.AbsolutePath === "string" && next.AbsolutePath) ||
    "";
  if (pathLike && typeof next.path !== "string") next.path = pathLike;

  const commandLike =
    (typeof next.command === "string" && next.command) ||
    (typeof next.CommandLine === "string" && next.CommandLine) ||
    (typeof next.commandLine === "string" && next.commandLine) ||
    (typeof next.cmd === "string" && next.cmd) ||
    "";
  if (commandLike && typeof next.command !== "string") next.command = commandLike;

  if (typeof next.Cwd === "string" && typeof next.cwd !== "string") next.cwd = next.Cwd;
  if (typeof next.toolSummary === "string" && !next.title) next.title = next.toolSummary;
  if (typeof next.toolAction === "string" && !next.description) {
    next.description = next.toolAction;
  }

  return next;
}

function toolOutputFromInfo(toolInfo) {
  if (!toolInfo || typeof toolInfo !== "object") return "";
  if (typeof toolInfo.output === "string" && toolInfo.output) return toolInfo.output;
  if (toolInfo.error && typeof toolInfo.error === "object") {
    if (typeof toolInfo.error.message === "string") return toolInfo.error.message;
    if (typeof toolInfo.error.type === "string") return toolInfo.error.type;
  }
  if (typeof toolInfo.error === "string") return toolInfo.error;
  return "";
}

function toolIdFromStep(step, toolName) {
  const index =
    typeof step.step_index === "number"
      ? step.step_index
      : typeof step.stepIndex === "number"
        ? step.stepIndex
        : "x";
  const name = String(toolName || "tool").replace(/\s+/g, "_");
  return `agy-${index}-${name}`;
}

function createAntigravityRuntime(cli) {
  let emittedRunStarted = false;
  let sawTextDelta = false;
  let modelLabel = resolveAgyModelLabel(cli && cli.model, cli && cli.reasoningEffort);

  return {
    extractSessionId(event) {
      return sessionIdFromEvent(event);
    },
    /**
     * Fallback for plain-text print mode (`--output-format text`) or non-JSON lines.
     * stream-json lines are JSON.parsed by process-supervisor and skip this path.
     * @returns {{ type: string, text: string } | null}
     */
    parseStdoutLine(line) {
      if (typeof line !== "string" || !line.length) return null;
      return { type: "agy.stdout", text: line };
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
            provider: "antigravity",
            model: modelLabel,
          })
        );
      };

      // --- stream-json / json envelopes ---
      if (event.event === "init") {
        const sessionId = sessionIdFromEvent(event);
        const init = event.init && typeof event.init === "object" ? event.init : {};
        if (typeof init.model === "string" && init.model.trim()) {
          modelLabel = init.model.trim();
        }
        ensureStarted(sessionId);
        return out;
      }

      if (event.event === "step_update" || event.event === "stepUpdate") {
        const step = event.step_update || event.stepUpdate;
        if (!step || typeof step !== "object") return out;
        ensureStarted(sessionIdFromEvent(event));

        const stepType = String(step.step_type || step.stepType || "").toLowerCase();
        const state = String(step.state || "").toUpperCase();
        const stepUsage = makeUsageEvent(base, step.usage || event.usage, {
          scope: "step",
          mode: "delta",
        });
        if (stepUsage) out.push(stepUsage);

        if (stepType === "agent_response") {
          const delta =
            typeof step.text_delta === "string"
              ? step.text_delta
              : typeof step.textDelta === "string"
                ? step.textDelta
                : "";
          if (delta) {
            sawTextDelta = true;
            out.push(makeEvent("text.delta", { ...base, text: delta }));
          }
          return out;
        }

        if (stepType === "tool") {
          const toolInfo = step.tool_info || step.toolInfo || {};
          const toolName =
            (typeof step.tool_name === "string" && step.tool_name) ||
            (typeof step.toolName === "string" && step.toolName) ||
            (typeof toolInfo.name === "string" && toolInfo.name) ||
            "tool";
          const toolId = toolIdFromStep(step, toolName);
          const args = normalizeToolArgs(toolInfo.parameters || toolInfo.Parameters || {});

          if (state === "ACTIVE" || state === "RUNNING" || state === "STARTED") {
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

          if (
            state === "DONE" ||
            state === "COMPLETED" ||
            state === "ERROR" ||
            state === "FAILED"
          ) {
            const failed = state === "ERROR" || state === "FAILED";
            out.push(
              makeEvent("tool.finished", {
                ...base,
                toolName,
                toolId,
                args,
                status: failed ? "error" : "ok",
                output: toolOutputFromInfo(toolInfo),
              })
            );
            return out;
          }
          return out;
        }

        // P1: checkpoint → progress
        if (stepType === "checkpoint") {
          const index =
            typeof step.step_index === "number"
              ? step.step_index
              : typeof step.stepIndex === "number"
                ? step.stepIndex
                : null;
          const label =
            index != null ? `检查点 #${index}` : state === "DONE" ? "检查点完成" : "检查点";
          out.push(
            makeEvent("progress.update", {
              ...base,
              items: [
                {
                  id: index != null ? `agy-checkpoint-${index}` : "agy-checkpoint",
                  text: label,
                  done: state === "DONE" || state === "COMPLETED",
                },
              ],
            })
          );
          return out;
        }

        // user_input is noise for UI; skip
        if (stepType === "user_input") {
          return out;
        }

        // P1: unknown / other step types → diagnostic (skip empty DONE unknowns lightly)
        if (stepType === "unknown" || stepType) {
          // Skip very chatty unknown DONE with no extra payload
          if (stepType === "unknown" && (state === "DONE" || state === "COMPLETED")) {
            return out;
          }
          out.push(
            makeEvent("diagnostic", {
              ...base,
              code: "agy.step_update",
              message: `step_type=${stepType || "?"} state=${state || "?"}`,
              rawType: stepType || "step_update",
            })
          );
          return out;
        }

        return out;
      }

      if (event.event === "result") {
        const result = event.result && typeof event.result === "object" ? event.result : event;
        ensureStarted(sessionIdFromEvent(event) || sessionIdFromEvent({ result }));
        const usage = makeUsageEvent(base, result.usage || event.usage, {
          scope: "run",
          mode: "cumulative",
        });

        // Avoid double-emitting response when agent_response text_delta already streamed.
        if (!sawTextDelta && typeof result.response === "string" && result.response) {
          sawTextDelta = true;
          out.push(makeEvent("text.delta", { ...base, text: result.response }));
        }

        const status = typeof result.status === "string" ? result.status.toUpperCase() : "";
        if (status && status !== "SUCCESS" && status !== "OK") {
          out.push(
            makeEvent("diagnostic", {
              ...base,
              code: "agy.result_status",
              message: `status=${result.status}`,
              rawType: "result",
            })
          );
        }
        if (usage) out.push(usage);
        return out;
      }

      // Final JSON blob (`--output-format json`): single object with response + conversation_id
      if (
        !event.event &&
        typeof event.conversation_id === "string" &&
        typeof event.response === "string"
      ) {
        ensureStarted(event.conversation_id);
        if (!sawTextDelta && event.response) {
          sawTextDelta = true;
          out.push(makeEvent("text.delta", { ...base, text: event.response }));
        }
        const usage = makeUsageEvent(base, event.usage, {
          scope: "run",
          mode: "cumulative",
        });
        if (usage) out.push(usage);
        return out;
      }

      // Legacy plain-text path
      if (event.type === "agy.stdout") {
        ensureStarted("");
        const text = typeof event.text === "string" ? event.text : "";
        if (text) {
          sawTextDelta = true;
          out.push(makeEvent("text.delta", { ...base, text: `${text}\n` }));
        }
        return out;
      }

      if (event.type === "text.delta" && typeof event.text === "string") {
        ensureStarted(sessionIdFromEvent(event));
        sawTextDelta = true;
        out.push(makeEvent("text.delta", { ...base, text: event.text }));
        return out;
      }

      // Unknown structured payload
      if (event.event || event.type) {
        ensureStarted(sessionIdFromEvent(event));
        out.push(
          makeEvent("diagnostic", {
            ...base,
            code: "agy.unknown_event",
            message: String(event.event || event.type || "unknown"),
            rawType: String(event.event || event.type || ""),
          })
        );
      }

      return out;
    },
    finish() {
      return [];
    },
  };
}

const antigravityProvider = {
  id: "antigravity",
  capabilities: {
    // stream-json emits conversation_id on init/result; --conversation resumes.
    resume: true,
    // No thinking text stream (only thinking_tokens / opaque thinkingSignature).
    thinking: false,
    tools: true,
    usage: true,
    reasoning: "levels",
  },
  allowedProviderOptions: [
    "mode",
    "sandbox",
    "skipPermissions",
    "printTimeout",
    "addDirs",
    "outputFormat",
  ],
  createRuntime: createAntigravityRuntime,
  resolveProxy,
  validate(config) {
    const effort = config.reasoningEffort || "high";
    if (effort && !SUPPORTED_EFFORTS.has(effort)) {
      throw new Error(
        `Unsupported Antigravity reasoning effort "${effort}". Supported: ${[
          ...SUPPORTED_EFFORTS,
        ].join(", ")}.`
      );
    }
    const mode = config.providerOptions && config.providerOptions.mode;
    if (mode && !SUPPORTED_MODES.has(mode)) {
      throw new Error(
        `Unsupported Antigravity mode "${mode}". Supported: ${[...SUPPORTED_MODES].join(", ")}.`
      );
    }
    const outputFormat = config.providerOptions && config.providerOptions.outputFormat;
    if (outputFormat && !SUPPORTED_OUTPUT_FORMATS.has(String(outputFormat))) {
      throw new Error(
        `Unsupported Antigravity outputFormat "${outputFormat}". Supported: ${[
          ...SUPPORTED_OUTPUT_FORMATS,
        ].join(", ")}.`
      );
    }
  },
  buildInvocation(config, prompt) {
    const providerOptions = config.providerOptions || {};
    const modelLabel = resolveAgyModelLabel(config.model, config.reasoningEffort);
    const args = ["-p", prompt, "--model", modelLabel];

    // Headless default: auto-approve tool calls (same role as codex -a never).
    if (providerOptions.skipPermissions !== false) {
      args.push("--dangerously-skip-permissions");
    }
    // Brainstorming agent defaults to plan mode (ideas without silent writes).
    // Override with providerOptions.mode = "accept-edits" or "" to clear.
    const mode =
      providerOptions.mode === undefined || providerOptions.mode === null
        ? "plan"
        : providerOptions.mode;
    if (mode) args.push("--mode", mode);

    // Windows defaults to buffered JSON to avoid Antigravity's incremental
    // UTF-8 corruption. Other platforms keep stream-json and tool events.
    const outputFormat = resolveAgyOutputFormat(providerOptions);
    if (outputFormat) args.push("--output-format", String(outputFormat));

    if (providerOptions.sandbox === true) args.push("--sandbox");
    if (providerOptions.printTimeout) {
      args.push("--print-timeout", String(providerOptions.printTimeout));
    }
    if (Array.isArray(providerOptions.addDirs)) {
      for (const dir of providerOptions.addDirs) {
        if (dir) args.push("--add-dir", String(dir));
      }
    }
    if (config.resumeSessionId) {
      args.push("--conversation", config.resumeSessionId);
    }

    return { command: resolveAgyCommand(), args };
  },
};

module.exports = {
  SUPPORTED_EFFORTS,
  SUPPORTED_MODES,
  SUPPORTED_OUTPUT_FORMATS,
  MODEL_FAMILY,
  resolveAgyModelLabel,
  resolveAgyCommand,
  resolveAgyOutputFormat,
  sessionIdFromEvent,
  normalizeToolArgs,
  createAntigravityRuntime,
  antigravityProvider,
};
