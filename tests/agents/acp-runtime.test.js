const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createProviderRuntime,
  buildProviderTransportInvocation,
} = require("../../src/agents/providers");
const {
  preferredPermission,
  decideAcpPermission,
  isAcpReadOnlyToolCall,
  shouldLoadAcpSession,
  buildAcpSessionParams,
} = require("../../src/agents/invoke-acp");
const { AGENTS } = require("../../src/agents/catalog");
const { ENV } = require("../../src/shared/brand");
const { applyImplementationPermissionGate } = require("../../src/agents/invoke-cli");

const ctx = { agent: "grok", invocationId: "inv-acp" };

test("Grok ACP invocation uses the native stdio agent", () => {
  const invocation = buildProviderTransportInvocation(AGENTS.grok, "ignored", "acp");
  assert.match(String(invocation.command), /grok(\.exe)?$/i);
  assert.deepEqual(invocation.args.slice(0, 1), ["agent"]);
  assert.ok(invocation.args.includes("--no-leader"));
  assert.ok(!invocation.args.includes("--plugin-dir"));
  assert.ok(invocation.args.includes("stdio"));
  assert.ok(invocation.args.includes("--always-approve"));
  assert.ok(!invocation.args.includes("--output-format"));
});

test("ACP runtime maps message, thought, and tool lifecycle to canonical events", () => {
  const runtime = createProviderRuntime(AGENTS.grok, { transport: "acp" });
  const seen = [];
  const push = (update) => {
    seen.push(
      ...runtime.transform({ type: "acp.session_update", sessionId: "acp-session", update }, ctx)
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
  assert.equal(started.title, "Read package.json");
  const finished = seen.find((event) => event.type === "tool.finished");
  assert.equal(finished.toolName, "read_file");
  assert.equal(finished.title, "Read `package.json`");
  assert.equal(finished.status, "ok");
  assert.deepEqual(finished.result, { name: "shift-console" });
  assert.ok(seen.some((event) => event.type === "text.delta" && event.text === "done"));
  assert.ok(!seen.some((event) => event.type === "file.changed"));
});

test("ACP spawn_subagent maps meta name/label and human title on finish", () => {
  const runtime = createProviderRuntime(AGENTS.grok, { transport: "acp" });
  const seen = [];
  const push = (update) => {
    seen.push(
      ...runtime.transform({ type: "acp.session_update", sessionId: "s-sub", update }, ctx)
    );
  };

  push({
    sessionUpdate: "tool_call",
    toolCallId: "call-spawn",
    title: "spawn_subagent",
    rawInput: {
      description: "List top-level dir entries",
      prompt: "list root",
      subagent_type: "explore",
      capability_mode: "read-only",
    },
    _meta: {
      "x.ai/tool": {
        name: "spawn_subagent",
        kind: "task",
        label: "Subagent",
        read_only: false,
      },
      subagentBackground: true,
    },
  });
  push({
    sessionUpdate: "tool_call_update",
    toolCallId: "call-spawn",
    title: "List top-level dir entries",
    kind: "other",
    rawInput: {
      variant: "Task",
      description: "List top-level dir entries",
      prompt: "list root",
      subagent_type: "explore",
      run_in_background: true,
    },
    _meta: {
      "x.ai/tool": {
        name: "spawn_subagent",
        kind: "task",
        label: "Subagent",
      },
    },
  });
  push({
    sessionUpdate: "tool_call_update",
    toolCallId: "call-spawn",
    status: "completed",
    rawOutput: {
      type: "Text",
      text: "Subagent started in background.\nsubagent_id: abc",
    },
  });

  const started = seen.find((event) => event.type === "tool.started");
  assert.equal(started.toolName, "spawn_subagent");
  assert.equal(started.label, "Subagent");
  assert.equal(started.toolKind, "task");
  assert.equal(started.args.subagent_type, "explore");

  const finished = seen.find((event) => event.type === "tool.finished");
  assert.equal(finished.toolName, "spawn_subagent");
  assert.equal(finished.title, "List top-level dir entries");
  assert.equal(finished.label, "Subagent");
  assert.equal(finished.toolKind, "task");
  assert.equal(finished.status, "ok");
  assert.equal(finished.args.subagent_type, "explore");
  assert.equal(finished.args.run_in_background, true);
  assert.equal(finished.args.description, "List top-level dir entries");
  assert.match(String(finished.result?.text || ""), /subagent_id/);
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

test("permission-capable ACP drops --always-approve until the plan hash is approved", () => {
  const locked = applyImplementationPermissionGate(AGENTS.grok, {});
  const lockedInvocation = buildProviderTransportInvocation(locked, "ignored", "acp");
  assert.equal(locked.executionGate.allowed, false);
  assert.ok(!lockedInvocation.args.includes("--always-approve"));

  const approved = applyImplementationPermissionGate(AGENTS.grok, {
    [ENV.IMPLEMENTATION_GATE]: "approved",
    [ENV.APPROVED_PLAN_HASH]: "plan-abc",
  });
  const approvedInvocation = buildProviderTransportInvocation(approved, "ignored", "acp");
  assert.equal(approved.executionGate.allowed, true);
  assert.ok(approvedInvocation.args.includes("--always-approve"));

  const withoutCallbacks = applyImplementationPermissionGate(AGENTS.codex, {});
  assert.equal(withoutCallbacks.executionGate, undefined);
});

test("Grok implementation gate allows only one-shot read tools before plan approval", () => {
  const options = [
    { optionId: "once", kind: "allow_once" },
    { optionId: "always", kind: "allow_always" },
  ];
  const locked = { executionGate: { allowed: false }, providerOptions: {} };

  const read = decideAcpPermission(
    { toolCall: { kind: "read", toolCallId: "read-1" }, options },
    locked
  );
  assert.equal(read.allowed, true);
  assert.equal(read.response.outcome.optionId, "once");

  for (const kind of ["edit", "delete", "move", "execute", "switch_mode", "other"]) {
    const decision = decideAcpPermission(
      { toolCall: { kind, toolCallId: `${kind}-1` }, options },
      locked
    );
    assert.equal(decision.allowed, false, `${kind} must stay locked`);
    assert.equal(decision.reason, "implementation_plan_not_approved");
    assert.equal(decision.response.outcome.outcome, "cancelled");
  }

  assert.equal(
    isAcpReadOnlyToolCall({
      kind: "read",
      name: "shell_command",
      rawInput: { command: "Set-Content changed.txt x" },
    }),
    false
  );
  assert.equal(
    decideAcpPermission(
      {
        toolCall: {
          kind: "read",
          name: "shell_command",
          rawInput: { command: "Set-Content changed.txt x" },
        },
        options,
      },
      locked
    ).allowed,
    false
  );
});

test("approved Grok gate restores the normal permission selection", () => {
  const decision = decideAcpPermission(
    {
      toolCall: { kind: "edit", toolCallId: "edit-approved" },
      options: [
        { optionId: "once", kind: "allow_once" },
        { optionId: "always", kind: "allow_always" },
      ],
    },
    { executionGate: { allowed: true }, providerOptions: { alwaysApprove: true } }
  );
  assert.equal(decision.allowed, true);
  assert.equal(decision.response.outcome.optionId, "always");
});

test("ACP permission denial is emitted as an auditable canonical diagnostic", () => {
  const runtime = createProviderRuntime(AGENTS.grok, { transport: "acp" });
  const events = runtime.transform(
    {
      type: "acp.permission_denied",
      sessionId: "locked-session",
      toolCallId: "edit-locked",
      toolKind: "edit",
      reason: "implementation_plan_not_approved",
    },
    ctx
  );
  const diagnostic = events.find((event) => event.type === "diagnostic");
  assert.equal(diagnostic.code, "implementation_plan_not_approved");
  assert.equal(diagnostic.toolId, "edit-locked");
  assert.match(diagnostic.message, /edit tool denied/);
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
  assert.equal(usage.outputTokens, 40);
  assert.equal(usage.totalTokens, 140);
});

test("ACP prompt result usage reads Grok _meta.usage when top-level usage is absent", () => {
  const runtime = createProviderRuntime(AGENTS.grok, { transport: "acp" });
  const events = runtime.transform(
    {
      type: "acp.prompt_result",
      sessionId: "grok-meta-usage",
      result: {
        stopReason: "end_turn",
        _meta: {
          inputTokens: 17097,
          outputTokens: 165,
          totalTokens: 17262,
          cachedReadTokens: 13824,
          reasoningTokens: 127,
          costUsdTicks: 207144000,
          usage: {
            inputTokens: 31028,
            outputTokens: 218,
            totalTokens: 31246,
            cachedReadTokens: 25088,
            reasoningTokens: 177,
            costUsdTicks: 207144000,
            modelCalls: 2,
            numTurns: 2,
          },
        },
      },
    },
    ctx
  );
  const usageEvents = events.filter((event) => event.type === "usage.update");
  assert.equal(usageEvents.length, 1);
  const usage = usageEvents[0];
  assert.equal(usage.inputTokens, 31028);
  assert.equal(usage.cachedInputTokens, 25088);
  assert.equal(usage.outputTokens, 218);
  assert.equal(usage.reasoningTokens, 177);
  assert.equal(usage.totalTokens, 31246);
  assert.equal(usage.costUsd, undefined);
});

test("ACP prompt result fills reasoning from _meta.usage when top-level usage omits it", () => {
  const runtime = createProviderRuntime(AGENTS.grok, { transport: "acp" });
  const events = runtime.transform(
    {
      type: "acp.prompt_result",
      sessionId: "usage-reasoning-fill",
      result: {
        stopReason: "end_turn",
        usage: {
          inputTokens: 31028,
          outputTokens: 218,
          cachedReadTokens: 25088,
          totalTokens: 31246,
        },
        _meta: {
          usage: {
            inputTokens: 31028,
            outputTokens: 218,
            cachedReadTokens: 25088,
            reasoningTokens: 177,
            totalTokens: 31246,
          },
        },
      },
    },
    ctx
  );
  const usage = events.find((event) => event.type === "usage.update");
  assert.equal(usage.inputTokens, 31028);
  assert.equal(usage.outputTokens, 218);
  assert.equal(usage.reasoningTokens, 177);
  assert.equal(usage.totalTokens, 31246);
});

test("ACP prompt result usage prefers top-level usage over _meta.usage", () => {
  const runtime = createProviderRuntime(AGENTS.grok, { transport: "acp" });
  const events = runtime.transform(
    {
      type: "acp.prompt_result",
      sessionId: "usage-priority",
      result: {
        stopReason: "end_turn",
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
        },
        _meta: {
          usage: {
            inputTokens: 31028,
            outputTokens: 218,
            totalTokens: 31246,
          },
        },
      },
    },
    ctx
  );
  const usage = events.find((event) => event.type === "usage.update");
  assert.equal(usage.inputTokens, 100);
  assert.equal(usage.outputTokens, 20);
  assert.equal(usage.totalTokens, 120);
});

test("ACP prompt result without usage does not emit a zero usage.update", () => {
  const runtime = createProviderRuntime(AGENTS.grok, { transport: "acp" });
  const events = runtime.transform(
    {
      type: "acp.prompt_result",
      sessionId: "no-usage",
      result: { stopReason: "end_turn" },
    },
    ctx
  );
  assert.equal(events.filter((event) => event.type === "usage.update").length, 0);
});

test("ACP usage_update maps context occupancy and does not write billing totals", () => {
  const runtime = createProviderRuntime(AGENTS.grok, { transport: "acp" });
  const events = runtime.transform(
    {
      type: "acp.session_update",
      sessionId: "context-usage",
      update: {
        sessionUpdate: "usage_update",
        used: 4096,
        size: 200000,
        cost: { currency: "USD", amount: 0.02 },
      },
    },
    ctx
  );
  const usage = events.find((event) => event.type === "usage.update");
  assert.equal(usage.contextTokens, 4096);
  assert.equal(usage.contextWindowTokens, 200000);
  assert.equal(usage.contextTokensExact, true);
  assert.equal(usage.costUsd, 0.02);
  assert.equal(usage.inputTokens, undefined);
  assert.equal(usage.outputTokens, undefined);
  assert.equal(usage.totalTokens, undefined);
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
  assert.equal(shouldLoadAcpSession({}, { agentCapabilities: { loadSession: true } }), false);
});

test("ACP new and load requests carry the same current MCP descriptors", () => {
  const mcpServers = [{ name: "shift_context", command: "node", args: [], env: [] }];
  assert.deepEqual(buildAcpSessionParams("C:/workspace", mcpServers), {
    cwd: "C:/workspace",
    mcpServers,
  });
  assert.deepEqual(buildAcpSessionParams("C:/workspace", mcpServers, "session-1"), {
    sessionId: "session-1",
    cwd: "C:/workspace",
    mcpServers,
  });
});
