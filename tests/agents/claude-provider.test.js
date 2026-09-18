const test = require("node:test");
const assert = require("node:assert/strict");
const {
  claudeProvider,
  createClaudeRuntime,
  classifyClaudeStderr,
  SUPPORTED_EFFORTS,
} = require("../../src/agents/providers/claude");
const {
  createProviderRuntime,
  buildProviderInvocation,
  buildProviderEnvironment,
  assertProviderAdapter,
} = require("../../src/agents/providers");
const { AGENTS } = require("../../src/agents/catalog");

const CTX = { agent: "claude", invocationId: "inv-1" };

/** Stream envelope helper: wrap an Anthropic stream event like the CLI does. */
function stream(event, sessionId = "ses-1", index = undefined) {
  const envelope = { type: "stream_event", event, session_id: sessionId };
  if (index !== undefined) envelope.event.index = index;
  return envelope;
}

test("adapter satisfies the provider contract", () => {
  assert.equal(assertProviderAdapter(claudeProvider), claudeProvider);
  assert.equal(claudeProvider.id, "claude");
  assert.equal(claudeProvider.capabilities.thinking, true);
  assert.equal(claudeProvider.capabilities.usage, true);
  assert.ok(Array.isArray(claudeProvider.allowedProviderOptions));
});

test("buildInvocation emits the flags the CLI requires for streaming", () => {
  const invocation = buildProviderInvocation(AGENTS.claude, "hello");
  assert.equal(invocation.command, "claude");
  // --print with stream-json exits 1 without --verbose.
  assert.ok(invocation.args.includes("-p"));
  assert.ok(invocation.args.includes("--output-format"));
  assert.ok(invocation.args.includes("stream-json"));
  assert.ok(invocation.args.includes("--verbose"));
  assert.ok(invocation.args.includes("--include-partial-messages"));
  assert.ok(invocation.args.includes("--dangerously-skip-permissions"));
  assert.ok(invocation.args.includes("--model"));
  assert.ok(invocation.args.includes("sonnet"));
  assert.equal(invocation.args.includes("claude-sonnet-5"), false);
  // Headless has no human to answer prompts; never leave this off by default.
  assert.ok(invocation.args.includes("--dangerously-skip-permissions"));
  // The shift_context MCP server is registered for parity with the other CLIs.
  const mcpIndex = invocation.args.indexOf("--mcp-config");
  assert.ok(mcpIndex > -1);
  const mcpConfig = JSON.parse(invocation.args[mcpIndex + 1]);
  assert.deepEqual(Object.keys(mcpConfig.mcpServers), ["shift_context"]);
  assert.equal(mcpConfig.mcpServers.shift_context.env, undefined);
  assert.doesNotMatch(invocation.args[mcpIndex + 1], /SHIFT_CALLBACK_TOKEN/);
  // --mcp-config is variadic; -- keeps the prompt from being read as a config.
  assert.deepEqual(invocation.args.slice(-2), ["--", "hello"]);
});

test("reasoning effort maps to --effort and rejects unknown levels", () => {
  const invocation = buildProviderInvocation({ ...AGENTS.claude, reasoningEffort: "max" }, "hello");
  const idx = invocation.args.indexOf("--effort");
  assert.ok(idx > -1);
  assert.equal(invocation.args[idx + 1], "max");

  // Catalog-level validation rejects the effort before the adapter runs.
  assert.throws(
    () => buildProviderInvocation({ ...AGENTS.claude, reasoningEffort: "ultra" }, "hello"),
    /Unsupported reasoning effort "ultra" for claude\/sonnet/
  );
  assert.deepEqual([...SUPPORTED_EFFORTS], ["low", "medium", "high", "xhigh", "max"]);
});

test("resume session id becomes --resume", () => {
  const invocation = buildProviderInvocation(
    { ...AGENTS.claude, resumeSessionId: "ses-resume" },
    "continue"
  );
  const idx = invocation.args.indexOf("--resume");
  assert.ok(idx > -1);
  assert.equal(invocation.args[idx + 1], "ses-resume");
});

test("allowedTools providerOption expands into the flag", () => {
  const invocation = buildProviderInvocation(
    { ...AGENTS.claude, providerOptions: { allowedTools: ["Read", "Grep"] } },
    "hello"
  );
  const idx = invocation.args.indexOf("--allowedTools");
  assert.ok(idx > -1);
  assert.deepEqual(invocation.args.slice(idx + 1, idx + 3), ["Read", "Grep"]);
});

test("unknown providerOptions fail fast", () => {
  assert.throws(
    () =>
      buildProviderInvocation(
        { ...AGENTS.claude, providerOptions: { skipPermissions: false } },
        "hello"
      ),
    /Unknown providerOptions for "claude": skipPermissions/
  );
});

test("system/init emits run.started and exposes the session id", () => {
  const runtime = createClaudeRuntime(AGENTS.claude);
  const events = runtime.transform(
    { type: "system", subtype: "init", session_id: "ses-init", model: "sonnet" },
    CTX
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ["run.started"]
  );
  assert.equal(events[0].sessionId, "ses-init");
  assert.equal(runtime.extractSessionId({ session_id: "ses-init" }), "ses-init");
  assert.equal(runtime.extractSessionId({ type: "system" }), "");
});

test("text_delta shards stream as separate text.delta events without duplication", () => {
  const runtime = createProviderRuntime(AGENTS.claude);
  const out = [];
  for (const shard of ["1+1", " 等于 ", "2。"]) {
    out.push(
      ...runtime.transform(
        stream(
          { type: "content_block_delta", delta: { type: "text_delta", text: shard } },
          "ses-1",
          0
        ),
        CTX
      )
    );
  }
  assert.deepEqual(
    out.map((event) => event.type),
    ["run.started", "text.delta", "text.delta", "text.delta"]
  );
  assert.equal(
    out
      .slice(1)
      .map((event) => event.text)
      .join(""),
    "1+1 等于 2。"
  );
});

test("assistant snapshot is dropped when shards already carried the text", () => {
  const runtime = createClaudeRuntime(AGENTS.claude);
  runtime.transform(
    stream({ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } }, "ses-1", 0),
    CTX
  );
  const events = runtime.transform(
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "hi" }] },
      session_id: "ses-1",
    },
    CTX
  );
  assert.deepEqual(events, []);
});

test("assistant fallback promotes the result line when no shards streamed", () => {
  const runtime = createClaudeRuntime(AGENTS.claude);
  runtime.transform({ type: "system", subtype: "init", session_id: "ses-1" }, CTX);
  runtime.transform(
    {
      type: "result",
      result: "final answer",
      session_id: "ses-1",
      is_error: false,
    },
    CTX
  );
  // The bare runtime emits only the promoted text; the envelope adds
  // run.finished on top (covered by provider-contract.test.js).
  const events = runtime.finish(CTX, { terminal: true, ok: true, exitCode: 0 });
  assert.deepEqual(
    events.map((event) => event.type),
    ["text.delta"]
  );
  assert.equal(events[0].text, "final answer");
});

test("result without text on success fails explicitly", () => {
  const runtime = createClaudeRuntime(AGENTS.claude);
  runtime.transform({ type: "system", subtype: "init", session_id: "ses-1" }, CTX);
  const events = runtime.finish(CTX, { terminal: true, ok: true, exitCode: 0 });
  assert.deepEqual(
    events.map((event) => event.type),
    ["run.failed"]
  );
  assert.match(events[0].error, /completed without a response/);
});

test("error result surfaces as stderr", () => {
  const runtime = createClaudeRuntime(AGENTS.claude);
  const events = runtime.transform(
    { type: "result", result: "boom", session_id: "ses-1", is_error: true },
    CTX
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ["stderr"]
  );
  assert.equal(events[0].text, "boom");
});

test("thinking_delta streams as thinking.delta", () => {
  const runtime = createClaudeRuntime(AGENTS.claude);
  const events = runtime.transform(
    stream(
      { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "reasoning" } },
      "ses-1",
      0
    ),
    CTX
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ["run.started", "thinking.delta"]
  );
  assert.equal(events[1].text, "reasoning");
});

test("tool args assembled from input_json_delta shards and started once", () => {
  const runtime = createClaudeRuntime(AGENTS.claude);
  const toolId = "chatcmpl-tool-1";
  const out = [];
  out.push(
    ...runtime.transform(
      stream(
        {
          type: "content_block_start",
          content_block: { type: "tool_use", id: toolId, name: "Read", input: {} },
        },
        "ses-1",
        1
      ),
      CTX
    )
  );
  for (const partial of ['{"file_path": "C:', "\\\\package", '.json"}']) {
    out.push(
      ...runtime.transform(
        stream(
          {
            type: "content_block_delta",
            delta: { type: "input_json_delta", partial_json: partial },
          },
          "ses-1",
          1
        ),
        CTX
      )
    );
  }
  out.push(...runtime.transform(stream({ type: "content_block_stop" }, "ses-1", 1), CTX));

  // content_block_start emits nothing; tool.started waits for complete args.
  assert.deepEqual(
    out.map((event) => event.type),
    ["run.started", "tool.started"]
  );
  assert.equal(out[1].toolName, "Read");
  assert.equal(out[1].toolId, toolId);
  assert.deepEqual(out[1].args, { file_path: "C:\\package.json" });
});

test("sequential tool blocks keep their args separate", () => {
  // Regression: assembly was keyed by tool id with a `:args` sentinel that
  // never matched, so every tool after the first got an empty args object.
  const runtime = createClaudeRuntime(AGENTS.claude);
  const out = [];
  out.push(
    ...runtime.transform(
      stream(
        {
          type: "content_block_start",
          content_block: { type: "tool_use", id: "t-a", name: "Read", input: {} },
        },
        "ses-1",
        0
      ),
      CTX
    )
  );
  out.push(
    ...runtime.transform(
      stream(
        {
          type: "content_block_delta",
          delta: { type: "input_json_delta", partial_json: '{"a":1}' },
        },
        "ses-1",
        0
      ),
      CTX
    )
  );
  out.push(...runtime.transform(stream({ type: "content_block_stop" }, "ses-1", 0), CTX));
  out.push(
    ...runtime.transform(
      stream(
        {
          type: "content_block_start",
          content_block: { type: "tool_use", id: "t-b", name: "Bash", input: {} },
        },
        "ses-1",
        1
      ),
      CTX
    )
  );
  out.push(
    ...runtime.transform(
      stream(
        {
          type: "content_block_delta",
          delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' },
        },
        "ses-1",
        1
      ),
      CTX
    )
  );
  out.push(...runtime.transform(stream({ type: "content_block_stop" }, "ses-1", 1), CTX));

  const started = out.filter((event) => event.type === "tool.started");
  assert.equal(started.length, 2);
  assert.deepEqual(started[0].args, { a: 1 });
  assert.deepEqual(started[1].args, { command: "ls" });
  assert.equal(started[1].toolName, "Bash");
});

test("interleaved tool blocks do not share a buffer", () => {
  // Parallel tool use opens both blocks before either stops; shards must land
  // by content-block index, not by whichever id happened to be first.
  const runtime = createClaudeRuntime(AGENTS.claude);
  const out = [];
  out.push(
    ...runtime.transform(
      stream(
        {
          type: "content_block_start",
          content_block: { type: "tool_use", id: "t-1", name: "Read", input: {} },
        },
        "ses-1",
        0
      ),
      CTX
    )
  );
  out.push(
    ...runtime.transform(
      stream(
        {
          type: "content_block_start",
          content_block: { type: "tool_use", id: "t-2", name: "Grep", input: {} },
        },
        "ses-1",
        1
      ),
      CTX
    )
  );
  out.push(
    ...runtime.transform(
      stream(
        {
          type: "content_block_delta",
          delta: { type: "input_json_delta", partial_json: '{"file_path":"a"}' },
        },
        "ses-1",
        0
      ),
      CTX
    )
  );
  out.push(
    ...runtime.transform(
      stream(
        {
          type: "content_block_delta",
          delta: { type: "input_json_delta", partial_json: '{"pattern":"x"}' },
        },
        "ses-1",
        1
      ),
      CTX
    )
  );
  out.push(...runtime.transform(stream({ type: "content_block_stop" }, "ses-1", 0), CTX));
  out.push(...runtime.transform(stream({ type: "content_block_stop" }, "ses-1", 1), CTX));

  const started = out.filter((event) => event.type === "tool.started");
  assert.deepEqual(started[0].args, { file_path: "a" });
  assert.deepEqual(started[1].args, { pattern: "x" });
});

test("tool_result finishes the tool with error status", () => {
  const runtime = createClaudeRuntime(AGENTS.claude);
  const toolId = "chatcmpl-tool-1";
  runtime.transform(
    stream(
      {
        type: "content_block_start",
        content_block: { type: "tool_use", id: toolId, name: "Read", input: {} },
      },
      "ses-1",
      1
    ),
    CTX
  );
  runtime.transform(stream({ type: "content_block_stop" }, "ses-1", 1), CTX);
  const events = runtime.transform(
    {
      type: "user",
      message: {
        role: "user",
        content: [
          { tool_use_id: toolId, type: "tool_result", content: "file body", is_error: false },
        ],
      },
      session_id: "ses-1",
    },
    CTX
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ["tool.finished"]
  );
  assert.equal(events[0].toolName, "Read");
  assert.equal(events[0].result, "file body");
  assert.equal(events[0].status, "ok");
});

test("tool_result with is_error reports error status", () => {
  const runtime = createClaudeRuntime(AGENTS.claude);
  const toolId = "chatcmpl-tool-2";
  runtime.transform(
    stream(
      {
        type: "content_block_start",
        content_block: { type: "tool_use", id: toolId, name: "Bash", input: {} },
      },
      "ses-1",
      1
    ),
    CTX
  );
  runtime.transform(stream({ type: "content_block_stop" }, "ses-1", 1), CTX);
  const events = runtime.transform(
    {
      type: "user",
      message: {
        role: "user",
        content: [{ tool_use_id: toolId, type: "tool_result", content: "failed", is_error: true }],
      },
      session_id: "ses-1",
    },
    CTX
  );
  assert.equal(events[0].status, "error");
});

test("message_delta usage flattens nested thinking_tokens", () => {
  const runtime = createClaudeRuntime(AGENTS.claude);
  const events = runtime.transform(
    stream({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: {
        input_tokens: 44,
        output_tokens: 12,
        cache_creation_input_tokens: 17472,
        cache_read_input_tokens: 704,
        output_tokens_details: { thinking_tokens: 8 },
      },
    }),
    CTX
  );
  const usage = events.find((event) => event.type === "usage.update");
  assert.ok(usage, "expected a usage.update event");
  // Anthropic's components are disjoint: input_tokens 44 + cache creation
  // 17472 + cache read 704 = 18220 total prompt tokens for this message.
  // Cache reads are additive, not a cap, so input covers the whole prompt.
  assert.equal(usage.inputTokens, 18220);
  assert.equal(usage.outputTokens, 12);
  assert.equal(usage.cachedInputTokens, 704);
  assert.equal(usage.reasoningTokens, 8);
  // message_delta covers one assistant message only: the per-message deltas
  // sum exactly to result.usage, so this is a delta, not a session watermark.
  assert.equal(usage.mode, "delta");
  assert.equal(usage.scope, "turn");
});

test("result usage is the authoritative cumulative total for the run", () => {
  const runtime = createClaudeRuntime(AGENTS.claude);
  const events = runtime.transform(
    {
      type: "result",
      result: "done",
      session_id: "ses-1",
      is_error: false,
      usage: {
        input_tokens: 115,
        output_tokens: 70,
        cache_creation_input_tokens: 1728,
        cache_read_input_tokens: 53952,
        output_tokens_details: { thinking_tokens: 0 },
      },
    },
    CTX
  );
  const usage = events.find((event) => event.type === "usage.update");
  assert.ok(usage, "expected a usage.update from result");
  assert.equal(usage.mode, "cumulative");
  assert.equal(usage.scope, "run");
  // Anthropic's components are disjoint: input 115 + cache creation 1728 +
  // cache read 53952 = 55795 total prompt tokens.
  assert.equal(usage.inputTokens, 55795);
  assert.equal(usage.cachedInputTokens, 53952);
  assert.equal(usage.outputTokens, 70);
});

test("error result is never promoted as the answer even on a clean exit", () => {
  // The CLI can exit 0 while reporting is_error; the result text is a failure
  // message and must become run.failed, not text.delta.
  const runtime = createClaudeRuntime(AGENTS.claude);
  runtime.transform(
    { type: "result", result: "refused: rate limited", session_id: "ses-1", is_error: true },
    CTX
  );
  const events = runtime.finish(CTX, { terminal: true, ok: true, exitCode: 0 });
  assert.deepEqual(
    events.map((event) => event.type),
    ["run.failed"]
  );
  assert.match(events[0].error, /refused: rate limited/);
});

test("error result after streamed text still fails the run on a clean exit", () => {
  const runtime = createProviderRuntime(AGENTS.claude);
  runtime.transform(
    stream(
      { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } },
      "ses-1",
      0
    ),
    CTX
  );
  runtime.transform(
    { type: "result", result: "refused: rate limited", session_id: "ses-1", is_error: true },
    CTX
  );
  const events = runtime.finish(CTX, { terminal: true, ok: true, exitCode: 0 });
  assert.equal(
    events.some((event) => event.type === "run.failed"),
    true
  );
  assert.equal(
    events.some((event) => event.type === "run.finished"),
    false
  );
  assert.match(events.find((event) => event.type === "run.failed").error, /refused: rate limited/);
});

test("result line maps run cost and the real context window", () => {
  const runtime = createClaudeRuntime(AGENTS.claude);
  const events = runtime.transform(
    {
      type: "result",
      result: "done",
      session_id: "ses-1",
      is_error: false,
      total_cost_usd: 0.040101,
      usage: { input_tokens: 10, output_tokens: 5 },
      modelUsage: {
        "atria-dawn-preview": {
          inputTokens: 10,
          outputTokens: 5,
          costUSD: 0.040101,
          contextWindow: 200000,
          maxOutputTokens: 32000,
        },
      },
    },
    CTX
  );
  const usage = events.find((event) => event.type === "usage.update");
  assert.ok(usage, "expected a usage.update from result");
  assert.equal(usage.costUsd, 0.040101);
  assert.equal(usage.contextWindowTokens, 200000);
});

test("error result still carries its usage after the stderr event", () => {
  const runtime = createClaudeRuntime(AGENTS.claude);
  const events = runtime.transform(
    {
      type: "result",
      result: "boom",
      session_id: "ses-1",
      is_error: true,
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    CTX
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ["stderr", "usage.update"]
  );
  assert.equal(events[1].mode, "cumulative");
});

test("unparsed input_json_delta falls back to a raw args string", () => {
  const runtime = createClaudeRuntime(AGENTS.claude);
  runtime.transform(
    stream(
      {
        type: "content_block_start",
        content_block: { type: "tool_use", id: "t-3", name: "Bash", input: {} },
      },
      "ses-1",
      1
    ),
    CTX
  );
  runtime.transform(
    stream(
      {
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: "not-json" },
      },
      "ses-1",
      1
    ),
    CTX
  );
  const events = runtime.transform(stream({ type: "content_block_stop" }, "ses-1", 1), CTX);
  assert.deepEqual(events[0].args, { raw: "not-json" });
});

test("stderr classifier maps real CLI failure strings", () => {
  // The CLI warns about an unknown model but keeps going and exits 0, so this
  // is a warning, not a run failure.
  const model = classifyClaudeStderr(
    '[claude-code:unrecognized_model] {"model":"bogus","query_source":"sdk"}'
  );
  assert.equal(model.code, "unrecognized_model");
  assert.equal(model.severity, "warning");
  assert.equal(model.affectsRun, false);
  assert.equal(model.visibility, "details");

  const auth = classifyClaudeStderr("Error: 401 Unauthorized - invalid api key");
  assert.equal(auth.code, "authentication_required");
  assert.equal(auth.affectsRun, true);

  const forbidden = classifyClaudeStderr("Error: 403 Forbidden");
  assert.equal(forbidden.code, "authentication_required");

  const missing = classifyClaudeStderr("Error: --output-format=stream-json requires --verbose");
  assert.equal(missing.code, "missing_verbose");

  const notFound = classifyClaudeStderr("'claude' is not recognized as an internal command");
  assert.equal(notFound.code, "command_missing");

  // Empty stderr is a hidden debug diagnostic, not a classified failure.
  assert.equal(classifyClaudeStderr("   ").code, "empty_stderr");
  assert.equal(classifyClaudeStderr("some harmless progress line"), null);
});

test("stderr classifier does not mistake incidental numbers for auth failures", () => {
  // Bare 401/403 appear in stack frames and version banners; matching them
  // would misreport an unrelated crash as an auth problem.
  assert.equal(
    classifyClaudeStderr("at Object.<anonymous> (index.js:401:18)"),
    null,
    "stack frame line numbers must not match auth"
  );
  assert.equal(
    classifyClaudeStderr("(node:40125) ExperimentalWarning: buffer is deprecated"),
    null,
    "node banner PIDs must not match auth"
  );
  // A Bash tool's own stderr must not become a "command missing" diagnostic.
  assert.equal(
    classifyClaudeStderr("ENOENT: no such file or directory, open 'missing.txt'"),
    null,
    "ENOENT from a tool must not be classified as a missing claude binary"
  );
});

test("environment bundle injects the catalog window unless already set", () => {
  const bundle = buildProviderEnvironment(AGENTS.claude, { proxy: "" }, {});
  assert.equal(bundle.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "256000");
  for (const key of Object.keys(bundle.env)) {
    assert.doesNotMatch(key, /^ANTHROPIC_/);
  }

  const preserved = buildProviderEnvironment(
    AGENTS.claude,
    { proxy: "" },
    { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "128000" }
  );
  assert.equal(preserved.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "128000");
});
