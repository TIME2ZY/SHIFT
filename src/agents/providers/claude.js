const { makeEvent } = require("../event-protocol");
const { makeUsageEvent } = require("../usage");
const { resolveProxy } = require("../proxy");
const { toolResultFromItem } = require("../../shared/tool-classification");
const { createClaudeShiftContextArg } = require("../shift-context-mcp-config");
const { AGENTS, resolveModelProfile } = require("../catalog");

/**
 * Claude Code CLI provider.
 *
 * Headless (verified claude 2.1.267):
 *   claude -p "prompt" --output-format stream-json --include-partial-messages \
 *     --verbose --dangerously-skip-permissions --model sonnet
 *
 * `--model sonnet` is the family alias. Claude Code maps it through
 * ANTHROPIC_DEFAULT_SONNET_MODEL; a full id like claude-sonnet-5 bypasses
 * that map and is rejected by gateways that only serve their own names.
 *
 * stream-json is NDJSON (one JSON object per line) wrapping Anthropic stream
 * events. `--print` + `stream-json` requires `--verbose` or the CLI exits 1.
 *
 * Envelope shapes and their canonical mapping:
 *   system/init        → run.started (session_id on every line → resume)
 *   stream_event       → unwrap .event, then by content_block type:
 *     text_delta         → text.delta (incremental shard)
 *     thinking_delta     → thinking.delta
 *     content_block_start(tool_use) → tool.started (args still empty)
 *     input_json_delta   → accumulate tool args
 *     content_block_stop → parse accumulated args onto the open tool
 *   user(tool_result)  → tool.finished
 *   message_delta      → usage.update
 *   result             → terminal; .result promotes the final answer
 *
 * Two duplication traps, both from the real wire format:
 * - `assistant` carries the whole message snapshot; the text_delta shards
 *   already carried it. Emitting both doubles the text.
 * - tool args do not arrive on content_block_start (input is {}); they stream
 *   in as input_json_delta shards and are only parseable at content_block_stop.
 */

const SUPPORTED_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

function claudeDiagnostic(code, severity, message, options = {}) {
  return {
    code,
    severity,
    message,
    fingerprint: `claude:${code}`,
    affectsRun: false,
    visibility: severity === "debug" ? "hidden" : "details",
    retryable: false,
    ...options,
  };
}

/** The result line reports per-model totals under modelUsage.<canonicalModel>. */
function firstModelUsage(event) {
  const byModel = event?.modelUsage;
  if (!byModel || typeof byModel !== "object") return null;
  const entry = Object.values(byModel).find(
    (value) => value && typeof value === "object" && typeof value.contextWindow === "number"
  );
  return entry || null;
}

function classifyClaudeStderr(line) {
  const text = String(line || "").trim();
  if (!text) return claudeDiagnostic("empty_stderr", "debug", "", { visibility: "hidden" });

  // The CLI warns about an unknown --model but keeps running and exits 0
  // (verified on a real run), so this is a warning, not a run failure.
  if (/^\[claude-code:unrecognized_model\]/i.test(text)) {
    return claudeDiagnostic(
      "unrecognized_model",
      "warning",
      "Claude CLI 不认识指定的模型，已回退到默认模型。",
      { affectsRun: false }
    );
  }
  // Anchored: bare "401"/"403" substrings appear in stack frames and version
  // banners ("index.js:401:18"), which must not masquerade as auth failures.
  if (
    /\b(?:401|403)\s+(?:unauthorized|forbidden)\b|invalid api key|not logged in|please (?:log|sign) in/i.test(
      text
    )
  ) {
    return claudeDiagnostic(
      "authentication_required",
      "error",
      "Claude CLI 登录已失效或未配置 API Key，请重新认证后重试。",
      { affectsRun: true, visibility: "inline", captureContinuation: true }
    );
  }
  if (/--output-format=stream-json requires --verbose/i.test(text)) {
    return claudeDiagnostic("missing_verbose", "error", "Claude 流式输出需要同时传 --verbose。", {
      affectsRun: true,
    });
  }
  if (/(?:^|\s)(?:command not found|is not recognized|无法将.+识别为)/i.test(text)) {
    return claudeDiagnostic(
      "command_missing",
      "error",
      "找不到 claude 命令，请检查安装和 PATH 后重新检测。",
      { affectsRun: true }
    );
  }
  return null;
}

function createClaudeRuntime(cli) {
  // Tool arg assembly: shards arrive after content_block_start, parse at stop.
  // Keyed by content-block index so interleaved tool blocks stay separate.
  const toolInputs = new Map();
  const blockTools = new Map();
  const blockBuffers = new Map();
  let emittedRunStarted = false;
  let lastResultText = "";
  let lastResultError = false;
  let streamedAnyText = false;

  function base(ctx) {
    return { agent: ctx.agent, invocationId: ctx.invocationId };
  }

  function maybeRunStarted(ctx, sessionId) {
    if (emittedRunStarted) return [];
    emittedRunStarted = true;
    return [
      makeEvent("run.started", {
        agent: ctx.agent,
        invocationId: ctx.invocationId,
        sessionId: sessionId || "",
        provider: cli.providerId,
        model: cli.model || "",
      }),
    ];
  }

  function textDeltaEvents(ctx, shard) {
    if (typeof shard !== "string" || !shard) return [];
    streamedAnyText = true;
    return [makeEvent("text.delta", { ...base(ctx), text: shard })];
  }

  function thinkingDeltaEvents(ctx, shard) {
    if (typeof shard !== "string" || !shard) return [];
    return [makeEvent("thinking.delta", { ...base(ctx), text: shard })];
  }

  /**
   * tool_use args arrive as input_json_delta shards after content_block_start.
   * Both start and stop carry the block's `index`, so shards are keyed by
   * index — not by tool id — which keeps interleaved/parallel tool blocks from
   * sharing one buffer. tool.started is emitted once, when args are complete.
   */
  function openToolBlock(ctx, block, index) {
    const toolName = String(block.name || "tool");
    const toolId = String(block.id || toolName);
    blockTools.set(index, { toolId, toolName });
    blockBuffers.set(index, "");
    toolInputs.set(toolId, toolName);
    return [];
  }

  function accumulateToolInput(index, partial) {
    if (typeof partial !== "string") return;
    blockBuffers.set(index, (blockBuffers.get(index) || "") + partial);
  }

  function completeToolBlock(ctx, index) {
    const block = blockTools.get(index);
    const raw = blockBuffers.get(index) || "";
    // Drop the block state: a later content_block may reuse the same index.
    blockTools.delete(index);
    blockBuffers.delete(index);
    if (!block) return [];
    let args = {};
    if (raw.trim()) {
      try {
        args = JSON.parse(raw);
      } catch {
        args = { raw };
      }
    }
    return [
      makeEvent("tool.started", {
        ...base(ctx),
        toolName: block.toolName,
        toolId: block.toolId,
        args,
      }),
    ];
  }

  function toolFinishedEvents(ctx, message) {
    const content = Array.isArray(message?.content) ? message.content : [];
    const events = [];
    for (const part of content) {
      if (!part || part.type !== "tool_result") continue;
      const toolId = String(part.tool_use_id || "");
      const toolName = toolInputs.get(toolId) || "tool";
      const failed = part.is_error === true;
      events.push(
        makeEvent("tool.finished", {
          ...base(ctx),
          toolName,
          toolId,
          result: typeof part.content === "string" ? part.content : toolResultFromItem(part),
          status: failed ? "error" : "ok",
        })
      );
    }
    return events;
  }

  function usageEvents(ctx, event, options = {}) {
    const raw = event?.usage;
    if (!raw || typeof raw !== "object") return [];
    const flattened = { ...raw };
    // normalizeUsage's ALIASES do not reach into output_tokens_details.
    const details = raw.output_tokens_details;
    if (details && typeof details.thinking_tokens === "number") {
      flattened.thinking_tokens = details.thinking_tokens;
    }
    // Anthropic reports cache creation as its own component, and cache reads
    // are DISJOINT from input_tokens (verified: message_start's input_tokens
    // 17936 = 16 fresh + 17216 written + 704 read). Fold creation into the
    // fresh-input count so the canonical input covers the whole prompt.
    if (typeof flattened.cache_creation_input_tokens === "number") {
      flattened.input_tokens =
        (flattened.input_tokens || 0) + flattened.cache_creation_input_tokens;
    }
    // message_delta usage covers one assistant message only (verified: the
    // per-message input/output deltas sum exactly to result.usage), so it is a
    // delta, not a session watermark. Only result.usage is cumulative.
    // The result line also carries run cost and the real context window under
    // modelUsage; both are flat-mapped here for the terminal event.
    if (options.scope === "run") {
      const modelUsage = firstModelUsage(event);
      if (modelUsage) {
        if (typeof modelUsage.costUSD === "number") flattened.cost_usd = modelUsage.costUSD;
        if (typeof modelUsage.contextWindow === "number") {
          flattened.context_window_tokens = modelUsage.contextWindow;
        }
      }
      if (typeof event.total_cost_usd === "number") flattened.cost_usd = event.total_cost_usd;
    }
    const usage = makeUsageEvent(base(ctx), flattened, {
      scope: options.scope || "turn",
      mode: options.mode || "delta",
      // cached reads are disjoint from input, so they add rather than cap it.
      cachedInputMode: "additional",
    });
    return usage ? [usage] : [];
  }

  function streamEventEvents(ctx, envelope, sessionId) {
    const event = envelope.event || {};
    const out = [];
    if (event.type === "message_start") {
      out.push(...maybeRunStarted(ctx, sessionId));
      return out;
    }
    if (event.type === "content_block_start") {
      const block = event.content_block || {};
      if (block.type === "tool_use") {
        out.push(...maybeRunStarted(ctx, sessionId));
        out.push(...openToolBlock(ctx, block, event.index));
      } else if (block.type === "text" || block.type === "thinking") {
        out.push(...maybeRunStarted(ctx, sessionId));
      }
      return out;
    }
    if (event.type === "content_block_delta") {
      const delta = event.delta || {};
      out.push(...maybeRunStarted(ctx, sessionId));
      if (delta.type === "text_delta") out.push(...textDeltaEvents(ctx, delta.text));
      else if (delta.type === "thinking_delta")
        out.push(...thinkingDeltaEvents(ctx, delta.thinking));
      else if (delta.type === "input_json_delta") {
        // Shards carry the block index, so they land in the right buffer even
        // when several tool blocks are open at once.
        if (blockBuffers.has(event.index)) accumulateToolInput(event.index, delta.partial_json);
      }
      return out;
    }
    if (event.type === "content_block_stop") {
      return completeToolBlock(ctx, event.index);
    }
    if (event.type === "message_delta") {
      out.push(...maybeRunStarted(ctx, sessionId));
      out.push(...usageEvents(ctx, event));
      return out;
    }
    return out;
  }

  return {
    extractSessionId(event) {
      if (!event || typeof event !== "object") return "";
      if (typeof event.session_id === "string" && event.session_id) return event.session_id;
      return "";
    },
    transform(event, ctx) {
      if (!event || typeof event !== "object") return [];
      const sessionId = event.session_id || "";

      if (event.type === "system" && event.subtype === "init") {
        return maybeRunStarted(ctx, sessionId);
      }
      // Heartbeat / status noise; carries no canonical content.
      if (event.type === "system") return [];

      if (event.type === "stream_event") {
        return streamEventEvents(ctx, event, sessionId);
      }

      if (event.type === "user") {
        return toolFinishedEvents(ctx, event.message);
      }

      if (event.type === "assistant") {
        // Snapshot of text the shards already delivered; re-emitting doubles
        // it. Dropped outright -- the no-shard fallback is result.result.
        return [];
      }

      if (event.type === "result") {
        lastResultText = typeof event.result === "string" ? event.result : "";
        lastResultError = event.is_error === true;
        // result.usage is the authoritative cumulative total for the run
        // (verified: the per-message deltas sum exactly to it).
        const usage = usageEvents(ctx, event, { scope: "run", mode: "cumulative" });
        if (event.is_error === true) {
          return [
            makeEvent("stderr", {
              ...base(ctx),
              text: lastResultText || "Claude CLI reported an error.",
            }),
            ...usage,
          ];
        }
        return usage;
      }

      return [];
    },
    finish(ctx, outcome = {}) {
      if (outcome.terminal !== true) return [];
      // CLI can exit 0 with is_error: true. Fail even if shards already
      // streamed; otherwise the envelope would emit run.finished.
      if (lastResultError) {
        return [
          makeEvent("run.failed", {
            ...base(ctx),
            error: lastResultText || "Claude CLI reported an error.",
          }),
        ];
      }
      // No streaming shards were seen (--include-partial-messages off, or a
      // pure-text result): promote the terminal result line once.
      if (streamedAnyText) return [];
      if (!lastResultText) {
        if (outcome.ok === true) {
          return [
            makeEvent("run.failed", {
              ...base(ctx),
              error: "Claude completed without a response.",
            }),
          ];
        }
        return [];
      }
      return [makeEvent("text.delta", { ...base(ctx), text: lastResultText })];
    },
  };
}

function buildClaudeEnvironment(_runOptions = {}, env = process.env, config = {}) {
  if (String(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS || "").trim()) return {};
  const modelId = config.model || AGENTS.claude?.model;
  const profile = resolveModelProfile("claude", modelId);
  const overlay = AGENTS.claude?.capacityTokens;
  const tokens = Number(overlay || profile?.contextTokens);
  if (!Number.isFinite(tokens) || tokens <= 0) return {};
  return { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(Math.floor(tokens)) };
}

const claudeProvider = {
  id: "claude",
  protocol: "cli",
  capabilities: {
    resume: true,
    thinking: true,
    tools: true,
    usage: true,
    reasoning: "levels",
  },
  allowedProviderOptions: ["allowedTools", "appendSystemPrompt"],
  createRuntime: createClaudeRuntime,
  classifyStderr: classifyClaudeStderr,
  resolveProxy,
  buildEnvironment: buildClaudeEnvironment,
  buildInvocation(config, prompt) {
    const providerOptions = config.providerOptions || {};
    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    // --include-partial-messages: text/thinking arrive as incremental shards.
    args.push("--include-partial-messages");
    // Headless with no human to answer prompts; matches the other CLIs'
    // full-access posture (codex -a never, grok --always-approve).
    args.push("--dangerously-skip-permissions");
    if (config.readOnlyInvocation) args.push("--tools", "Read,Glob,Grep");
    if (config.model) args.push("--model", config.model);
    if (config.reasoningEffort) {
      const effort = String(config.reasoningEffort).trim().toLowerCase();
      if (SUPPORTED_EFFORTS.has(effort)) {
        args.push("--effort", effort);
      } else {
        throw new Error(
          `Unsupported Claude reasoning effort "${effort}". Supported: ${[
            ...SUPPORTED_EFFORTS,
          ].join(", ")}.`
        );
      }
    }
    if (Array.isArray(providerOptions.allowedTools) && providerOptions.allowedTools.length) {
      args.push("--allowedTools", ...providerOptions.allowedTools);
    }
    if (providerOptions.appendSystemPrompt) {
      args.push("--append-system-prompt", String(providerOptions.appendSystemPrompt));
    }
    // The shift_context stdio server gives the seat in-turn memory write,
    // recall search, and platform skills, matching every other adapter.
    // --mcp-config accepts an inline JSON string, so no temp file is needed.
    if (!config.readOnlyInvocation) args.push("--mcp-config", createClaudeShiftContextArg());
    else args.push("--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}');
    if (config.resumeSessionId) args.push("--resume", config.resumeSessionId);
    // --mcp-config is variadic (<configs...>) and would swallow the prompt as
    // another config path; -- ends option parsing and keeps the prompt positional.
    if (!config.readOnlyInvocation) args.push("--", prompt);
    return { command: "claude", args, stdinText: config.readOnlyInvocation ? prompt : undefined };
  },
};

module.exports = {
  SUPPORTED_EFFORTS,
  classifyClaudeStderr,
  createClaudeRuntime,
  buildClaudeEnvironment,
  claudeProvider,
};
