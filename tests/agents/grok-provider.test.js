const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  createGrokRuntime,
  THINKING_FLUSH_CHARS,
  TEXT_FLUSH_CHARS,
  resolveGrokCommand,
} = require("../../src/agents/providers/grok");
const { AGENTS, getAgentModelProfile } = require("../../src/agents/catalog");
const { buildInvocation } = require("../../src/agents/invoke-cli");
const {
  createProviderRuntime,
  listSupportedProviders,
  buildProviderTransportInvocation,
  buildProviderTransportMcpServers,
} = require("../../src/agents/providers");

test("provider registry includes grok", () => {
  assert.ok(listSupportedProviders().includes("grok"));
  const runtime = createProviderRuntime({ providerId: "grok", model: "grok-4.6" });
  assert.equal(typeof runtime.transform, "function");
  assert.equal(typeof runtime.extractSessionId, "function");
});

test("AGENTS.grok is catalogued with grok-4.6 high", () => {
  assert.ok(AGENTS.grok);
  assert.equal(AGENTS.grok.providerId, "grok");
  assert.equal(AGENTS.grok.model, "grok-4.6");
  assert.equal(AGENTS.grok.reasoningEffort, "high");
  assert.equal(AGENTS.grok.capacityTokens, undefined);
  assert.equal(getAgentModelProfile("grok").contextTokens, 500_000);
});

test("buildInvocation for grok spawns local grok CLI headless", () => {
  const inv = buildInvocation(AGENTS.grok, "hello world");
  assert.match(String(inv.command), /grok(\.exe)?$/i);
  assert.ok(inv.args.includes("-p"));
  assert.ok(inv.args.includes("hello world"));
  assert.ok(inv.args.includes("--output-format"));
  assert.ok(inv.args.includes("streaming-json"));
  assert.ok(inv.args.includes("-m"));
  assert.ok(inv.args.includes("grok-4.6"));
  assert.ok(inv.args.includes("--reasoning-effort"));
  assert.ok(inv.args.includes("high"));
  assert.ok(inv.args.includes("--always-approve"));
  assert.ok(!inv.args.includes("--no-subagents"), "subagents allowed by default");
});

test("grok capabilities expose ACP tools while retaining CLI transport metadata", () => {
  const { getProviderAdapter } = require("../../src/agents/providers");
  const adapter = getProviderAdapter("grok");
  const caps = adapter.capabilities;
  assert.equal(caps.thinking, true);
  assert.equal(caps.tools, true);
  assert.equal(caps.resume, true);
  assert.equal(adapter.cliCapabilities.tools, false);
});

test("buildInvocation can disable subagents via providerOptions.noSubagents=true", () => {
  const inv = buildInvocation(
    {
      ...AGENTS.grok,
      providerOptions: { noSubagents: true },
    },
    "x"
  );
  assert.ok(inv.args.includes("--no-subagents"));
});

test("Grok ACP injects Shift MCP through the session descriptor", () => {
  const inv = buildProviderTransportInvocation(AGENTS.grok, "probe", "acp");
  assert.ok(inv.args.includes("--no-leader"));
  assert.ok(!inv.args.includes("--plugin-dir"));
  const env = {
    SHIFT_API_URL: "http://127.0.0.1:8787",
    SHIFT_THREAD_ID: "thread-1",
    SHIFT_INVOCATION_ID: "inv-1",
    SHIFT_CALLBACK_TOKEN: "token-1",
  };
  const [server] = buildProviderTransportMcpServers(AGENTS.grok, env, "acp");
  assert.equal(server.name, "shift_context");
  assert.equal(server.command, process.execPath);
  assert.match(server.args[0], /shift-context-mcp\.js$/);
  assert.deepEqual(server.env, [
    { name: "SHIFT_API_URL", value: env.SHIFT_API_URL },
    { name: "SHIFT_THREAD_ID", value: env.SHIFT_THREAD_ID },
    { name: "SHIFT_INVOCATION_ID", value: env.SHIFT_INVOCATION_ID },
    { name: "SHIFT_CALLBACK_TOKEN", value: env.SHIFT_CALLBACK_TOKEN },
  ]);
});

test("buildInvocation for grok resumes with -r session id", () => {
  const inv = buildInvocation(
    { ...AGENTS.grok, resumeSessionId: "019f50e8-88a0-7ee1-b525-df3b193ced6b" },
    "continue"
  );
  const rIdx = inv.args.indexOf("-r");
  assert.ok(rIdx >= 0);
  assert.equal(inv.args[rIdx + 1], "019f50e8-88a0-7ee1-b525-df3b193ced6b");
});

test("buildInvocation passes unknown grok models through to the CLI", () => {
  const inv = buildInvocation(
    { providerId: "grok", model: "grok-nope", reasoningEffort: "high" },
    "x"
  );
  assert.ok(inv.args.includes("-m"));
  assert.ok(inv.args.includes("grok-nope"));
});

test("resolveGrokCommand returns a string", () => {
  const cmd = resolveGrokCommand();
  assert.equal(typeof cmd, "string");
  assert.ok(cmd.length > 0);
});

test("createGrokRuntime coalesces many tiny thought tokens", () => {
  const runtime = createGrokRuntime({ providerId: "grok", model: "grok-4.6" });
  const ctx = { agent: "grok", invocationId: "inv-1" };

  const pieces = ["The", " user", " wants", " a", " short", " answer."];
  let thinkingEvents = 0;
  let started = 0;
  let combined = "";

  for (const piece of pieces) {
    const events = runtime.transform({ type: "thought", data: piece }, ctx);
    for (const e of events) {
      if (e.type === "run.started") started += 1;
      if (e.type === "thinking.delta") {
        thinkingEvents += 1;
        combined += e.text;
      }
    }
  }
  // Flush remaining via end
  const endEvents = runtime.transform({ type: "end", sessionId: "s1" }, ctx);
  for (const e of endEvents) {
    if (e.type === "thinking.delta") {
      thinkingEvents += 1;
      combined += e.text;
    }
  }

  assert.equal(started, 1);
  assert.equal(combined, pieces.join(""));
  // Must be far fewer than one event per token
  assert.ok(
    thinkingEvents < pieces.length,
    `expected coalesce, got ${thinkingEvents} for ${pieces.length} tokens`
  );
  assert.ok(thinkingEvents >= 1);
});

test("createGrokRuntime flushes thinking before text and coalesces text", () => {
  const runtime = createGrokRuntime({ providerId: "grok", model: "grok-4.6" });
  const ctx = { agent: "grok", invocationId: "inv-2" };

  // Under threshold: still buffered
  let events = runtime.transform({ type: "thought", data: "think " }, ctx);
  assert.ok(events.some((e) => e.type === "run.started"));
  assert.ok(!events.some((e) => e.type === "thinking.delta"));

  // Switch to text forces thinking flush
  events = runtime.transform({ type: "text", data: "Hel" }, ctx);
  assert.ok(events.some((e) => e.type === "thinking.delta" && e.text === "think "));
  // "Hel" alone may still be buffered
  const earlyText = events.filter((e) => e.type === "text.delta");
  assert.ok(earlyText.length <= 1);

  events = runtime.transform({ type: "text", data: "lo world, this is enough text." }, ctx);
  const textParts = events
    .filter((e) => e.type === "text.delta")
    .map((e) => e.text)
    .join("");

  events = runtime.transform({ type: "end", sessionId: "s2" }, ctx);
  const finalText =
    textParts +
    events
      .filter((e) => e.type === "text.delta")
      .map((e) => e.text)
      .join("");
  assert.match(finalText, /Hello world/);
});

test("createGrokRuntime extracts session id from end", () => {
  const runtime = createGrokRuntime({ providerId: "grok", model: "grok-4.6" });
  assert.equal(
    runtime.extractSessionId({
      type: "end",
      sessionId: "019f50e8-88a0-7ee1-b525-df3b193ced6b",
      stopReason: "EndTurn",
    }),
    "019f50e8-88a0-7ee1-b525-df3b193ced6b"
  );
});

test("grok end converts additional cached input to the canonical inclusive input", () => {
  const runtime = createProviderRuntime({ providerId: "grok", model: "grok-4.6" });
  const events = runtime.transform(
    {
      type: "end",
      sessionId: "grok-usage",
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 40,
        output_tokens: 30,
        reasoning_tokens: 10,
        total_tokens: 170,
        cost: 0.25,
      },
    },
    { agent: "grok", invocationId: "inv-usage" }
  );
  const usage = events.find((event) => event.type === "usage.update");
  assert.ok(usage);
  assert.equal(usage.inputTokens, 140);
  assert.equal(usage.cachedInputTokens, 40);
  assert.equal(usage.reasoningTokens, 10);
  assert.equal(usage.totalTokens, 170);
  assert.equal(usage.costUsd, 0.25);
});

test("coalesce thresholds are positive", () => {
  assert.ok(THINKING_FLUSH_CHARS >= 40);
  assert.ok(TEXT_FLUSH_CHARS >= 16);
});

test("identity file exists for grok and mentions CLI", () => {
  const file = path.join(__dirname, "../../src/agents/identities/grok.md");
  assert.ok(fs.existsSync(file));
  const body = fs.readFileSync(file, "utf8");
  assert.match(body, /id: grok/);
  assert.match(body, /Grok CLI\/ACP/);
});

test("createGrokRuntime maps tool_use / tool_result to tool.*", () => {
  const runtime = createGrokRuntime({ providerId: "grok", model: "grok-4.6" });
  const ctx = { agent: "grok", invocationId: "inv-tool" };
  const started = runtime.transform(
    {
      type: "tool_use",
      name: "bash",
      id: "t1",
      input: { command: "ls" },
    },
    ctx
  );
  assert.ok(started.some((e) => e.type === "tool.started" && e.toolName === "bash"));
  const finished = runtime.transform(
    {
      type: "tool_result",
      name: "bash",
      id: "t1",
      output: "ok",
      status: "ok",
    },
    ctx
  );
  assert.ok(finished.some((e) => e.type === "tool.finished" && e.toolId === "t1"));
});
