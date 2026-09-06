const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createAntigravityRuntime,
  resolveAgyModelLabel,
  resolveAgyCommand,
  resolveAgyOutputFormat,
  sessionIdFromEvent,
  normalizeToolArgs,
  antigravityProvider,
} = require("../../src/agents/providers/antigravity");
const { AGENTS } = require("../../src/agents/catalog");
const { buildInvocation } = require("../../src/agents/invoke-cli");
const { createProviderRuntime, listSupportedProviders } = require("../../src/agents/providers");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("provider registry includes antigravity", () => {
  assert.ok(listSupportedProviders().includes("antigravity"));
  const runtime = createProviderRuntime({
    providerId: "antigravity",
    model: "gemini-3.6-flash",
    reasoningEffort: "high",
  });
  assert.equal(typeof runtime.transform, "function");
  assert.equal(typeof runtime.parseStdoutLine, "function");
});

test("AGENTS.gemini is catalogued as a Gemini 3.8 Flash runtime", () => {
  assert.ok(AGENTS.gemini);
  assert.equal(AGENTS.gemini.label, "Gemini");
  assert.equal(AGENTS.gemini.providerId, "antigravity");
  assert.equal(AGENTS.gemini.model, "gemini-3.8-flash");
  assert.equal(AGENTS.gemini.reasoningEffort, "high");
  assert.match(AGENTS.gemini.description, /Antigravity CLI runtime/);
});

test("resolveAgyModelLabel embeds effort in CLI model name", () => {
  assert.equal(resolveAgyModelLabel("gemini-3.8-flash", "high"), "Gemini 3.8 Flash (High)");
  assert.equal(resolveAgyModelLabel("gemini-3.8-flash", "medium"), "Gemini 3.8 Flash (Medium)");
  assert.equal(resolveAgyModelLabel("gemini-3.6-flash", "high"), "Gemini 3.6 Flash (High)");
  assert.equal(resolveAgyModelLabel("gemini-3.5-flash", "high"), "Gemini 3.5 Flash (High)");
  assert.equal(resolveAgyModelLabel("gemini-3.1-pro", "low"), "Gemini 3.1 Pro (Low)");
  assert.equal(resolveAgyModelLabel("gemini-3.7-flash", "high"), "Gemini 3.7 Flash (High)");
  assert.equal(
    resolveAgyModelLabel("Gemini 3.8 Flash (High)", "medium"),
    "Gemini 3.8 Flash (High)"
  );
  assert.throws(() => resolveAgyModelLabel(""), /Antigravity model is required/);
});

test("buildInvocation for gemini uses the platform-safe print mode", () => {
  const inv = buildInvocation(AGENTS.gemini, "brainstorm names");
  assert.match(String(inv.command), /agy(\.exe)?$/i);
  assert.ok(inv.args.includes("-p"));
  assert.ok(inv.args.includes("brainstorm names"));
  assert.ok(inv.args.includes("--model"));
  assert.ok(inv.args.includes("Gemini 3.8 Flash (High)"));
  assert.ok(inv.args.includes("--dangerously-skip-permissions"));
  assert.ok(inv.args.includes("--mode"));
  assert.ok(inv.args.includes("plan"));
  const fmtIdx = inv.args.indexOf("--output-format");
  assert.ok(fmtIdx >= 0);
  assert.equal(inv.args[fmtIdx + 1], process.platform === "win32" ? "json" : "stream-json");
});

test("Windows defaults to buffered json while explicit output format wins", () => {
  assert.equal(resolveAgyOutputFormat({}, {}, "win32"), "json");
  assert.equal(resolveAgyOutputFormat({}, {}, "linux"), "stream-json");
  assert.equal(resolveAgyOutputFormat({ outputFormat: "text" }, {}, "win32"), "text");
  assert.equal(
    resolveAgyOutputFormat({}, { AGY_OUTPUT_FORMAT: "stream-json" }, "win32"),
    "stream-json"
  );
  assert.throws(
    () => resolveAgyOutputFormat({}, { AGY_OUTPUT_FORMAT: "invalid" }, "win32"),
    /Unsupported Antigravity outputFormat/
  );
});

test("buildInvocation resumes with --conversation", () => {
  const inv = buildInvocation(
    { ...AGENTS.gemini, resumeSessionId: "ac743010-d674-432f-a4a9-bf20647ceb54" },
    "continue ideas"
  );
  const idx = inv.args.indexOf("--conversation");
  assert.ok(idx >= 0);
  assert.equal(inv.args[idx + 1], "ac743010-d674-432f-a4a9-bf20647ceb54");
});

test("Antigravity environment registration installs Shift MCP without credentials", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "shift-agy-provider-"));
  try {
    antigravityProvider.buildEnvironment({}, { USERPROFILE: home });
    const raw = fs.readFileSync(path.join(home, ".gemini", "config", "mcp_config.json"), "utf8");
    assert.match(raw, /shift_context/);
    assert.doesNotMatch(raw, /SHIFT_CALLBACK_TOKEN/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("buildInvocation rejects unsupported effort", () => {
  assert.throws(
    () =>
      buildInvocation(
        { providerId: "antigravity", model: "gemini-3.6-flash", reasoningEffort: "ultra" },
        "x"
      ),
    /Unsupported reasoning effort "ultra"/
  );
});

test("buildInvocation honors outputFormat override", () => {
  const inv = buildInvocation(
    {
      ...AGENTS.gemini,
      providerOptions: { outputFormat: "text" },
    },
    "plain"
  );
  const fmtIdx = inv.args.indexOf("--output-format");
  assert.ok(fmtIdx >= 0);
  assert.equal(inv.args[fmtIdx + 1], "text");
});

test("resolveAgyCommand returns a string", () => {
  const cmd = resolveAgyCommand();
  assert.equal(typeof cmd, "string");
  assert.ok(cmd.length > 0);
});

test("normalizeToolArgs maps DirectoryPath and CommandLine", () => {
  assert.equal(
    normalizeToolArgs({ DirectoryPath: "D:\\HW\\Muti-Agent" }).path,
    "D:\\HW\\Muti-Agent"
  );
  assert.equal(normalizeToolArgs({ CommandLine: "npm test" }).command, "npm test");
});

test("sessionIdFromEvent reads conversation_id from envelopes", () => {
  assert.equal(sessionIdFromEvent({ conversation_id: "c1" }), "c1");
  assert.equal(
    sessionIdFromEvent({ step_update: { conversation_id: "c2", step_type: "tool" } }),
    "c2"
  );
  assert.equal(sessionIdFromEvent({ result: { conversation_id: "c3" } }), "c3");
  assert.equal(sessionIdFromEvent({}), "");
});

test("createAntigravityRuntime maps plain stdout lines to text.delta", () => {
  const runtime = createAntigravityRuntime(AGENTS.gemini);
  const ctx = { agent: "gemini", invocationId: "inv-g1" };

  const synthetic = runtime.parseStdoutLine("fresh idea one");
  assert.equal(synthetic.type, "agy.stdout");

  const events = runtime.transform(synthetic, ctx);
  assert.equal(events[0].type, "run.started");
  assert.equal(events[0].provider, "antigravity");
  assert.equal(events[0].model, "Gemini 3.8 Flash (High)");
  assert.equal(events[1].type, "text.delta");
  assert.equal(events[1].text, "fresh idea one\n");

  const more = runtime.transform(runtime.parseStdoutLine("fresh idea two"), ctx);
  assert.deepEqual(
    more.map((e) => e.type),
    ["text.delta"]
  );
  assert.equal(more[0].text, "fresh idea two\n");
});

test("stream-json init + text + tool + result maps to canonical events", () => {
  const runtime = createAntigravityRuntime(AGENTS.gemini);
  const ctx = { agent: "gemini", invocationId: "inv-stream" };
  const conv = "f2995446-2a12-4008-a630-2b6776092d82";

  const started = runtime.transform(
    {
      event: "init",
      conversation_id: conv,
      init: {
        model: "Gemini 3.6 Flash (High)",
        cwd: "D:\\HW\\Muti-Agent",
        tools: ["list_dir"],
        permission_mode: "always-proceed",
      },
    },
    ctx
  );
  assert.equal(started.length, 1);
  assert.equal(started[0].type, "run.started");
  assert.equal(started[0].sessionId, conv);
  assert.equal(started[0].model, "Gemini 3.6 Flash (High)");
  assert.equal(runtime.extractSessionId({ event: "init", conversation_id: conv }), conv);

  const text1 = runtime.transform(
    {
      event: "step_update",
      step_update: {
        conversation_id: conv,
        step_index: 2,
        state: "ACTIVE",
        step_type: "agent_response",
        text_delta: "I'll use list_dir. ",
      },
    },
    ctx
  );
  assert.deepEqual(
    text1.map((e) => e.type),
    ["text.delta"]
  );
  assert.equal(text1[0].text, "I'll use list_dir. ");

  const toolStart = runtime.transform(
    {
      event: "step_update",
      step_update: {
        conversation_id: conv,
        step_index: 3,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "list_dir",
        tool_info: {
          name: "list_dir",
          parameters: { DirectoryPath: "D:\\HW\\Muti-Agent" },
        },
      },
    },
    ctx
  );
  assert.equal(toolStart[0].type, "tool.started");
  assert.equal(toolStart[0].toolName, "list_dir");
  assert.equal(toolStart[0].toolId, "agy-3-list_dir");
  assert.equal(toolStart[0].args.path, "D:\\HW\\Muti-Agent");

  const toolDone = runtime.transform(
    {
      event: "step_update",
      step_update: {
        conversation_id: conv,
        step_index: 3,
        state: "DONE",
        step_type: "tool",
        tool_name: "list_dir",
        tool_info: {
          name: "list_dir",
          parameters: { DirectoryPath: "D:\\HW\\Muti-Agent" },
          output: "src/\npublic/\n",
        },
      },
    },
    ctx
  );
  assert.equal(toolDone[0].type, "tool.finished");
  assert.equal(toolDone[0].status, "ok");
  assert.equal(toolDone[0].output, "src/\npublic/\n");

  const toolErr = runtime.transform(
    {
      event: "step_update",
      step_update: {
        conversation_id: conv,
        step_index: 4,
        state: "ERROR",
        step_type: "tool",
        tool_name: "list_dir",
        tool_info: {
          name: "list_dir",
          parameters: { DirectoryPath: "C:\\secret" },
          error: { type: "TOOL_ERROR", message: "Permission denied" },
        },
      },
    },
    ctx
  );
  assert.equal(toolErr[0].type, "tool.finished");
  assert.equal(toolErr[0].status, "error");
  assert.match(toolErr[0].output, /Permission denied/);

  const checkpoint = runtime.transform(
    {
      event: "step_update",
      step_update: {
        conversation_id: conv,
        step_index: 5,
        state: "DONE",
        step_type: "checkpoint",
      },
    },
    ctx
  );
  assert.equal(checkpoint[0].type, "progress.update");
  assert.match(checkpoint[0].items[0].text, /检查点/);

  // result.response must not duplicate streamed text
  const result = runtime.transform(
    {
      event: "result",
      result: {
        conversation_id: conv,
        status: "SUCCESS",
        response: "I'll use list_dir. final summary\n",
        usage: { thinking_tokens: 100 },
      },
    },
    ctx
  );
  assert.deepEqual(
    result.map((e) => e.type),
    ["usage.update"]
  );
  assert.equal(result[0].reasoningTokens, 100);
  assert.equal(result[0].scope, "run");
});

test("result emits text when no agent_response deltas were seen", () => {
  const runtime = createAntigravityRuntime(AGENTS.gemini);
  const ctx = { agent: "gemini", invocationId: "inv-result-only" };
  runtime.transform(
    { event: "init", conversation_id: "c-result", init: { model: "Gemini 3.5 Flash (Low)" } },
    ctx
  );
  const events = runtime.transform(
    {
      event: "result",
      result: {
        conversation_id: "c-result",
        status: "SUCCESS",
        response: "only final\n",
      },
    },
    ctx
  );
  assert.equal(events[0].type, "text.delta");
  assert.equal(events[0].text, "only final\n");
});

test("step and result usage expose delta and cumulative scopes", () => {
  const runtime = createProviderRuntime({
    providerId: "antigravity",
    model: "gemini-3.6-flash",
  });
  const ctx = { agent: "gemini", invocationId: "inv-agy-usage" };
  const step = runtime.transform(
    {
      event: "step_update",
      step_update: {
        conversation_id: "agy-usage",
        step_type: "unknown",
        state: "ACTIVE",
        usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 5 },
      },
    },
    ctx
  );
  const stepUsage = step.find((event) => event.type === "usage.update");
  assert.equal(stepUsage.scope, "step");
  assert.equal(stepUsage.mode, "delta");
  assert.equal(stepUsage.totalTokens, 120);

  const result = runtime.transform(
    {
      event: "result",
      result: {
        conversation_id: "agy-usage",
        status: "SUCCESS",
        usage: { input_tokens: 150, output_tokens: 30, thinking_tokens: 8 },
      },
    },
    ctx
  );
  const runUsage = result.find((event) => event.type === "usage.update");
  assert.equal(runUsage.scope, "run");
  assert.equal(runUsage.mode, "cumulative");
  assert.equal(runUsage.totalTokens, 180);
});

test("final json blob maps conversation_id and response", () => {
  const runtime = createAntigravityRuntime(AGENTS.gemini);
  const ctx = { agent: "gemini", invocationId: "inv-json" };
  const events = runtime.transform(
    {
      conversation_id: "json-conv",
      status: "SUCCESS",
      response: "FMT_json\n",
      usage: { thinking_tokens: 10 },
    },
    ctx
  );
  assert.equal(events[0].type, "run.started");
  assert.equal(events[0].sessionId, "json-conv");
  assert.equal(events[1].type, "text.delta");
  assert.equal(events[1].text, "FMT_json\n");
  assert.equal(events[2].type, "usage.update");
  assert.equal(events[2].reasoningTokens, 10);
});

test("user_input and unknown DONE steps are quiet", () => {
  const runtime = createAntigravityRuntime(AGENTS.gemini);
  const ctx = { agent: "gemini", invocationId: "inv-quiet" };
  runtime.transform({ event: "init", conversation_id: "q1", init: {} }, ctx);
  assert.deepEqual(
    runtime
      .transform(
        {
          event: "step_update",
          step_update: {
            conversation_id: "q1",
            step_index: 0,
            state: "DONE",
            step_type: "user_input",
          },
        },
        ctx
      )
      .map((e) => e.type),
    []
  );
  assert.deepEqual(
    runtime
      .transform(
        {
          event: "step_update",
          step_update: {
            conversation_id: "q1",
            step_index: 1,
            state: "DONE",
            step_type: "unknown",
          },
        },
        ctx
      )
      .map((e) => e.type),
    []
  );
});

test("antigravity adapter declares stream-json capabilities", () => {
  assert.equal(antigravityProvider.id, "antigravity");
  assert.equal(antigravityProvider.capabilities.resume, true);
  assert.equal(antigravityProvider.capabilities.thinking, false);
  assert.equal(antigravityProvider.capabilities.tools, true);
  assert.equal(antigravityProvider.capabilities.subagents, undefined);
  assert.ok(antigravityProvider.allowedProviderOptions.includes("mode"));
  assert.ok(antigravityProvider.allowedProviderOptions.includes("outputFormat"));
});
