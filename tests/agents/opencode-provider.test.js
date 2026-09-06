const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createOpencodeRuntime,
  opencodeProvider,
  normalizeToolArgs,
  sessionIdFromEvent,
} = require("../../src/agents/providers/opencode");
const { createProviderRuntime, buildProviderEnvironment } = require("../../src/agents/providers");
const { buildInvocation } = require("../../src/agents/invoke-cli");
const { AGENTS } = require("../../src/agents/catalog");

test("provider API error retains its actionable message", () => {
  const runtime = createOpencodeRuntime(AGENTS.opencode);
  const events = runtime.transform(
    {
      type: "error",
      error: {
        name: "APIError",
        data: { message: "Insufficient balance", responseHeaders: { secret: "omit" } },
      },
    },
    { agent: "opencode", invocationId: "probe" }
  );
  assert.equal(events[0].type, "stderr");
  assert.equal(events[0].text, "Insufficient balance");
  assert.equal(JSON.stringify(events).includes("secret"), false);
});

test("normalizeToolArgs maps filePath to path for UI", () => {
  assert.deepEqual(normalizeToolArgs({ filePath: "a/b.js" }).path, "a/b.js");
  assert.deepEqual(normalizeToolArgs({ file_path: "x" }).path, "x");
  assert.equal(normalizeToolArgs({ path: "keep", filePath: "other" }).path, "keep");
});

test("sessionIdFromEvent reads sessionID on lines", () => {
  assert.equal(sessionIdFromEvent({ sessionID: "ses_1" }), "ses_1");
  assert.equal(sessionIdFromEvent({ part: { sessionID: "ses_2" } }), "ses_2");
});

test("opencode maps real tool_use with filePath to tool.* with path", () => {
  const runtime = createProviderRuntime({
    providerId: "opencode",
    model: "deepseek-v4-flash",
  });
  const ctx = { agent: "opencode", invocationId: "inv-fp" };
  const events = runtime.transform(
    {
      type: "tool_use",
      sessionID: "ses_real",
      part: {
        type: "tool",
        tool: "read",
        callID: "read_0",
        state: {
          status: "completed",
          input: { filePath: "D:/HW/package.json" },
          output: "ok",
        },
      },
    },
    ctx
  );
  assert.ok(events.some((e) => e.type === "run.started" && e.sessionId === "ses_real"));
  const started = events.find((e) => e.type === "tool.started");
  assert.ok(started);
  assert.equal(started.toolName, "read");
  assert.equal(started.toolId, "read_0");
  assert.equal(started.args.path, "D:/HW/package.json");
  assert.equal(started.args.filePath, "D:/HW/package.json");
  assert.ok(events.some((e) => e.type === "tool.finished" && e.status === "ok"));
});

test("opencode maps reasoning + text sample shapes", () => {
  const runtime = createOpencodeRuntime({ providerId: "opencode", model: "deepseek-v4-flash" });
  const ctx = { agent: "opencode", invocationId: "inv-rt" };
  const think = runtime.transform(
    {
      type: "reasoning",
      sessionID: "ses_a",
      part: { type: "reasoning", id: "r1", text: "thinking hard" },
    },
    ctx
  );
  assert.ok(think.some((e) => e.type === "thinking.delta" && e.text.includes("thinking hard")));
  const text = runtime.transform(
    {
      type: "text",
      sessionID: "ses_a",
      part: { type: "text", text: "hello from opencode" },
    },
    ctx
  );
  assert.ok(text.some((e) => e.type === "text.delta" && e.text === "hello from opencode"));
});

test("buildInvocation for opencode uses format json, thinking, auto, and max variant", () => {
  const inv = buildInvocation(AGENTS.opencode, "review please");
  assert.match(String(inv.command), /opencode/i);
  assert.ok(inv.args.includes("run"));
  assert.ok(inv.args.includes("--format"));
  assert.ok(inv.args.includes("json"));
  assert.ok(inv.args.includes("--thinking"));
  assert.ok(inv.args.includes("--auto"));
  assert.ok(inv.args.includes("--model"));
  assert.ok(inv.args.some((a) => String(a).includes("deepseek-v4-flash")));
  assert.ok(inv.args.includes("--variant"));
  assert.ok(inv.args.includes("max"));
  assert.equal(AGENTS.opencode.model, "deepseek-v4-flash");
  assert.equal(AGENTS.opencode.reasoningEffort, "max");
});

test("buildInvocation can disable autoApprove", () => {
  const inv = buildInvocation({ ...AGENTS.opencode, providerOptions: { autoApprove: false } }, "x");
  assert.ok(!inv.args.includes("--auto"));
});

test("OpenCode receives Shift MCP through invocation-local config", () => {
  const { env } = buildProviderEnvironment(AGENTS.opencode, {}, { OPENCODE_CONFIG_CONTENT: "{}" });
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  assert.equal(config.mcp.shift_context.type, "local");
  assert.match(config.mcp.shift_context.command[1], /shift-context-mcp\.js$/);
});

test("opencode capabilities remain tools+thinking", () => {
  assert.equal(opencodeProvider.capabilities.tools, true);
  assert.equal(opencodeProvider.capabilities.thinking, true);
});

test("opencode step_finish maps tokens and cost to usage.update", () => {
  const runtime = createProviderRuntime({ providerId: "opencode", model: "deepseek-v4-flash" });
  const events = runtime.transform(
    {
      type: "step_finish",
      sessionID: "ses_usage",
      part: {
        type: "step-finish",
        reason: "stop",
        tokens: { input: 200, output: 50, reasoning: 15, cache: { read: 80 } },
        cost: 0.04,
      },
    },
    { agent: "opencode", invocationId: "inv-usage" }
  );
  const usage = events.find((event) => event.type === "usage.update");
  assert.ok(usage);
  assert.equal(usage.scope, "step");
  assert.equal(usage.mode, "delta");
  assert.equal(usage.inputTokens, 280);
  assert.equal(usage.totalTokens, 330);
  assert.equal(usage.cachedInputTokens, 80);
  assert.equal(usage.costUsd, 0.04);
});
