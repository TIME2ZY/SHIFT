const assert = require("node:assert/strict");
const test = require("node:test");
const { createProviderRuntime, buildProviderTransportInvocation } = require("../../src/agents/providers");
const { preferredPermission, shouldLoadAcpSession } = require("../../src/agents/invoke-acp");
const { AGENTS } = require("../../src/agents/catalog");

const ctx = { agent: "grok", invocationId: "inv-acp" };

test("Grok ACP invocation uses the native stdio agent", () => {
  const invocation = buildProviderTransportInvocation(AGENTS.grok, "ignored", "acp");
  assert.match(String(invocation.command), /grok(\.exe)?$/i);
  assert.deepEqual(invocation.args.slice(0, 1), ["agent"]);
  assert.ok(invocation.args.includes("stdio"));
  assert.ok(invocation.args.includes("--always-approve"));
  assert.ok(!invocation.args.includes("--output-format"));
});

test("ACP runtime maps message, thought, and tool lifecycle to canonical events", () => {
  const runtime = createProviderRuntime(AGENTS.grok, { transport: "acp" });
  const seen = [];
  const push = (update) => {
    seen.push(
      ...runtime.transform(
        { type: "acp.session_update", sessionId: "acp-session", update },
        ctx
      )
    );
  };

  push({
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "inspect package" },
  });
  push({
    sessionUpdate: "tool_call",
    toolCallId: "call-1",
    name: "read_file",
    title: "Read package.json",
    kind: "read",
    status: "in_progress",
    rawInput: { target_file: "package.json" },
    locations: [{ path: "package.json", line: 1 }],
  });
  push({
    sessionUpdate: "tool_call_update",
    toolCallId: "call-1",
    status: "completed",
    title: "Read `package.json`",
    rawOutput: { name: "shift-console" },
    locations: [{ path: "package.json", line: 1 }],
  });
  push({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "done" },
  });
  seen.push(...runtime.finish(ctx));

  assert.equal(seen[0].type, "run.started");
  assert.equal(seen[0].sessionId, "acp-session");
  assert.ok(seen.some((event) => event.type === "thinking.delta"));
  const started = seen.find((event) => event.type === "tool.started");
  assert.deepEqual(started.args, { target_file: "package.json" });
  const finished = seen.find((event) => event.type === "tool.finished");
  assert.equal(finished.toolName, "read_file");
  assert.equal(finished.status, "ok");
  assert.deepEqual(finished.result, { name: "shift-console" });
  assert.ok(seen.some((event) => event.type === "text.delta" && event.text === "done"));
  assert.ok(!seen.some((event) => event.type === "file.changed"));
});

test("ACP edit locations map to file.changed and plans map to progress", () => {
  const runtime = createProviderRuntime(AGENTS.grok, { transport: "acp" });
  const edit = runtime.transform(
    {
      type: "acp.session_update",
      sessionId: "s2",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "edit-1",
        name: "edit_file",
        kind: "edit",
        locations: [{ path: "src/a.js" }],
      },
    },
    ctx
  );
  assert.ok(edit.some((event) => event.type === "file.changed" && event.path === "src/a.js"));

  const plan = runtime.transform(
    {
      type: "acp.session_update",
      sessionId: "s2",
      update: {
        sessionUpdate: "plan",
        entries: [{ content: "Run tests", priority: "high", status: "in_progress" }],
      },
    },
    ctx
  );
  const progress = plan.find((event) => event.type === "progress.update");
  assert.equal(progress.items[0].label, "Run tests");
});

test("ACP permission selection prefers persistent allow then one-shot allow", () => {
  assert.equal(
    preferredPermission([
      { optionId: "once", kind: "allow_once" },
      { optionId: "always", kind: "allow_always" },
    ]).optionId,
    "always"
  );
  assert.equal(preferredPermission([{ optionId: "once", kind: "allow_once" }]).optionId, "once");
  assert.equal(preferredPermission([{ optionId: "deny", kind: "reject_once" }]), null);
});

test("ACP prompt result usage maps to the shared usage event", () => {
  const runtime = createProviderRuntime(AGENTS.grok, { transport: "acp" });
  const events = runtime.transform(
    {
      type: "acp.prompt_result",
      sessionId: "usage-session",
      result: {
        stopReason: "end_turn",
        usage: {
          inputTokens: 100,
          cachedReadTokens: 20,
          outputTokens: 30,
          thoughtTokens: 10,
          totalTokens: 140,
        },
      },
    },
    ctx
  );
  const usage = events.find((event) => event.type === "usage.update");
  assert.equal(usage.inputTokens, 100);
  assert.equal(usage.cachedInputTokens, 20);
  assert.equal(usage.reasoningTokens, 10);
  assert.equal(usage.totalTokens, 140);
});

test("ACP session reuse selects session/load only when both id and capability exist", () => {
  assert.equal(
    shouldLoadAcpSession(
      { resumeSessionId: "session-1" },
      { agentCapabilities: { loadSession: true } }
    ),
    true
  );
  assert.equal(
    shouldLoadAcpSession(
      { resumeSessionId: "session-1" },
      { agentCapabilities: { loadSession: false } }
    ),
    false
  );
  assert.equal(
    shouldLoadAcpSession({}, { agentCapabilities: { loadSession: true } }),
    false
  );
});
