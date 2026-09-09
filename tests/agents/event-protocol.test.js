const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PROTOCOL_VERSION,
  makeEvent,
  normalizeCanonicalEvent,
  validateCanonicalEvent,
  assertCanonicalEvent,
  createRunLifecycle,
  lifecyclePhase,
} = require("../../src/agents/event-protocol");
const { createProviderRuntime } = require("../../src/agents/providers");

test("makeEvent stamps protocolVersion", () => {
  const event = makeEvent("text.delta", {
    agent: "codex",
    invocationId: "inv-1",
    text: "hi",
  });
  assert.equal(event.protocolVersion, PROTOCOL_VERSION);
  assert.equal(event.type, "text.delta");
});

test("commentary.delta is a first-class canonical content event", () => {
  const event = makeEvent("commentary.delta", {
    agent: "codex",
    invocationId: "inv-commentary",
    text: "working",
  });
  assert.doesNotThrow(() => assertCanonicalEvent(event));
  assert.equal(lifecyclePhase(event.type), "content");
});

test("canonical protocol rejects removed event types", () => {
  const {
    CANONICAL_EVENT_TYPES,
    validateCanonicalEvent,
  } = require("../../src/agents/event-protocol");
  for (const type of [
    "subagent.started",
    "subagent.progress",
    "subagent.completed",
    "subagent.failed",
    "thinking.final",
    "command.started",
    "command.finished",
  ]) {
    assert.equal(CANONICAL_EVENT_TYPES.has(type), false);
    const errors = validateCanonicalEvent({
      type,
      agent: "codex",
      invocationId: "i",
      text: "x",
      command: "x",
      subagentId: "s1",
    });
    assert.ok(errors.some((e) => /unsupported event type/.test(e)));
  }
});

test("diagnostic and optional fields validate", () => {
  const diag = makeEvent("diagnostic", {
    agent: "codex",
    invocationId: "i",
    code: "unmapped_event",
    rawType: "foo",
    message: "not mapped",
  });
  assert.doesNotThrow(() => assertCanonicalEvent(diag));

  const classified = makeEvent("diagnostic", {
    agent: "codex",
    invocationId: "i",
    code: "model_refresh",
    severity: "warning",
    visibility: "details",
    fingerprint: "codex:model-refresh",
    count: 2,
    affectsRun: false,
    retryable: true,
    providerRaw: { text: "raw warning" },
  });
  assert.doesNotThrow(() => assertCanonicalEvent(classified));
  assert.throws(
    () => assertCanonicalEvent({ ...classified, severity: "fatal" }),
    /diagnostic\.severity/
  );

  const started = makeEvent("run.started", {
    agent: "codex",
    invocationId: "i",
    provider: "codex",
    model: "m",
    sessionId: "ses_1",
  });
  assert.equal(started.sessionId, "ses_1");
  assert.doesNotThrow(() => assertCanonicalEvent(started));

  const tool = makeEvent("tool.started", {
    agent: "codex",
    invocationId: "i",
    toolName: "bash",
    toolId: "t1",
    args: { command: "ls" },
  });
  assert.deepEqual(tool.args, { command: "ls" });
  assert.doesNotThrow(() => assertCanonicalEvent(tool));

  const file = makeEvent("file.changed", {
    agent: "codex",
    invocationId: "i",
    path: "a.js",
    changeType: "add",
  });
  assert.equal(file.changeType, "add");
  assert.doesNotThrow(() => assertCanonicalEvent(file));
});

test("usage.update validates normalized provider-neutral fields", () => {
  const usage = makeEvent("usage.update", {
    agent: "codex",
    invocationId: "inv-usage",
    scope: "turn",
    mode: "cumulative",
    inputTokens: "100",
    outputTokens: 20,
    totalTokens: 120,
  });
  assert.equal(usage.inputTokens, 100);
  assert.doesNotThrow(() => assertCanonicalEvent(usage));
  const invalid = validateCanonicalEvent({ ...usage, scope: "session" });
  assert.ok(invalid.some((error) => /scope/.test(error)));
  const negativeContext = validateCanonicalEvent({ ...usage, contextTokens: -1 });
  assert.ok(negativeContext.some((error) => /contextTokens/.test(error)));
  assert.ok(
    validateCanonicalEvent({ ...usage, cachedInputTokens: 101 }).some((error) =>
      /cachedInputTokens must be a subset/.test(error)
    )
  );
  assert.ok(
    validateCanonicalEvent({ ...usage, reasoningTokens: 21 }).some((error) =>
      /reasoningTokens must be a subset/.test(error)
    )
  );
  assert.ok(
    validateCanonicalEvent({ ...usage, totalTokens: 121 }).some((error) =>
      /totalTokens must equal/.test(error)
    )
  );
});

test("normalize coerces loose field types before validation", () => {
  const event = normalizeCanonicalEvent({
    type: "text.delta",
    agent: "codex",
    invocationId: "inv-1",
    text: 42,
  });
  assert.equal(event.text, "42");
  assert.equal(event.protocolVersion, PROTOCOL_VERSION);
  assert.doesNotThrow(() => assertCanonicalEvent(event));
});

test("validateCanonicalEvent rejects wrong types when not coerced", () => {
  const errors = validateCanonicalEvent({
    type: "text.delta",
    agent: "codex",
    invocationId: "inv-1",
    text: 42,
  });
  assert.ok(errors.some((e) => /text must be a string/.test(e)));
});

test("validateCanonicalEvent rejects future protocol versions", () => {
  const errors = validateCanonicalEvent({
    type: "text.delta",
    agent: "a",
    invocationId: "i",
    text: "x",
    protocolVersion: PROTOCOL_VERSION + 10,
  });
  assert.ok(errors.some((e) => /unsupported protocolVersion/.test(e)));
});

test("run lifecycle accepts started → content → one terminal only", () => {
  const life = createRunLifecycle();
  assert.equal(lifecyclePhase("text.delta"), "content");
  assert.equal(life.accept("run.started"), true);
  assert.equal(life.accept("run.started"), false);
  assert.equal(life.accept("text.delta"), true);
  assert.equal(life.accept("thinking.delta"), true);
  assert.equal(life.accept("run.finished"), true);
  assert.equal(life.accept("run.failed"), false);
  assert.equal(life.accept("text.delta"), false);
  assert.equal(life.terminal, true);
});

test("runtime envelope drops content after terminal and stamps protocolVersion", () => {
  const runtime = createProviderRuntime({
    providerId: "codex",
    model: "gpt-5.6-sol",
  });
  const ctx = { agent: "codex", invocationId: "inv-proto" };

  const first = runtime.transform(
    { type: "item.completed", item: { type: "agent_message", text: "hello" } },
    ctx
  );
  assert.deepEqual(
    first.map((e) => e.type),
    ["run.started", "commentary.delta"]
  );
  assert.ok(first.every((e) => e.protocolVersion === PROTOCOL_VERSION));

  const finished = runtime.finish(ctx, { terminal: true, ok: true, exitCode: 0 });
  assert.deepEqual(
    finished.map((e) => e.type),
    ["text.delta", "run.finished"]
  );
  assert.equal(finished[0].text, "hello");

  const late = runtime.transform(
    { type: "item.completed", item: { type: "agent_message", text: "late" } },
    ctx
  );
  assert.deepEqual(late, []);
  assert.deepEqual(runtime.finish(ctx, { terminal: true, ok: true, exitCode: 0 }), []);
});

test("runtime envelope closes open tools before the invocation terminal event", () => {
  const lifecycle = createRunLifecycle();
  const runtime = createProviderRuntime(
    {
      providerId: "codex",
      model: "gpt-5.6-sol",
    },
    { lifecycle }
  );
  const ctx = { agent: "codex", invocationId: "inv-open-tool" };

  const started = runtime.transform(
    {
      type: "item.started",
      item: {
        id: "tool-1",
        type: "mcp_tool_call",
        tool: "web_search",
        arguments: { query: "SHIFT" },
      },
    },
    ctx
  );
  assert.deepEqual(
    started.map((event) => event.type),
    ["run.started", "tool.started"]
  );
  assert.equal(lifecycle.openToolCount, 1);

  const terminal = runtime.finish(ctx, { terminal: true, ok: true, exitCode: 0 });
  assert.deepEqual(
    terminal.map((event) => event.type),
    ["tool.finished", "run.finished"]
  );
  assert.equal(terminal[0].type, "tool.finished");
  assert.equal(terminal[0].agent, "codex");
  assert.equal(terminal[0].invocationId, "inv-open-tool");
  assert.equal(terminal[0].toolName, "web_search");
  assert.equal(terminal[0].toolId, "tool-1");
  assert.deepEqual(terminal[0].args, { query: "SHIFT" });
  assert.equal(terminal[0].status, "interrupted");
  assert.equal(terminal[0].state, "interrupted");
  assert.equal(terminal[0].error, "Provider run ended before the tool reported completion.");
  assert.equal(terminal[0].failureSource, "lifecycle-terminal");
  assert.ok(terminal[0].ts);
  assert.ok(terminal[0].createdAt);
  assert.equal(lifecycle.openToolCount, 0);
});

test("open tool lifecycle survives a provider retry and closes only at final termination", () => {
  const lifecycle = createRunLifecycle();
  const config = { providerId: "codex", model: "gpt-5.6-sol" };
  const ctx = { agent: "codex", invocationId: "inv-tool-retry" };
  const attempt1 = createProviderRuntime(config, { lifecycle });

  attempt1.transform(
    {
      type: "item.started",
      item: { id: "tool-retry", type: "mcp_tool_call", tool: "read", arguments: {} },
    },
    ctx
  );
  assert.deepEqual(attempt1.finish(ctx, { terminal: false }), []);
  assert.equal(lifecycle.openToolCount, 1);

  const attempt2 = createProviderRuntime(config, { lifecycle });
  const terminal = attempt2.finish(ctx, {
    terminal: true,
    ok: false,
    exitCode: 1,
    error: "provider failed",
  });
  assert.deepEqual(
    terminal.map((event) => event.type),
    ["tool.finished", "run.failed"]
  );
  assert.equal(terminal[0].error, "provider failed");
  assert.equal(lifecycle.openToolCount, 0);
});

test("shared lifecycle across recreated runtimes suppresses second run.started", () => {
  const { createRunLifecycle } = require("../../src/agents/event-protocol");
  const lifecycle = createRunLifecycle();
  const config = { providerId: "codex", model: "gpt-5.6-sol" };
  const ctx = { agent: "codex", invocationId: "inv-retry" };

  const attempt1 = createProviderRuntime(config, { lifecycle });
  const first = attempt1.transform(
    { type: "item.completed", item: { type: "agent_message", text: "a" } },
    ctx
  );
  assert.deepEqual(
    first.map((e) => e.type),
    ["run.started", "commentary.delta"]
  );
  // Intermediate process failure: flush without terminal.
  assert.deepEqual(attempt1.finish(ctx, { terminal: false }), []);

  const attempt2 = createProviderRuntime(config, { lifecycle });
  const second = attempt2.transform(
    { type: "item.completed", item: { type: "agent_message", text: "b" } },
    ctx
  );
  assert.deepEqual(
    second.map((e) => e.type),
    ["commentary.delta"]
  );
  assert.equal(second[0].text, "b");
  assert.deepEqual(
    attempt2.finish(ctx, { terminal: true, ok: true, exitCode: 0 }).map((e) => e.type),
    ["text.delta", "run.finished"]
  );
});

test("shared usage accumulator suppresses replayed cumulative usage after retry", () => {
  const { createUsageAccumulator } = require("../../src/agents/usage");
  const lifecycle = createRunLifecycle();
  const usageAccumulator = createUsageAccumulator();
  const config = { providerId: "codex", model: "gpt-5.6-sol" };
  const ctx = { agent: "codex", invocationId: "inv-usage-retry" };
  const raw = {
    type: "turn.completed",
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
  };
  const first = createProviderRuntime(config, { lifecycle, usageAccumulator }).transform(raw, ctx);
  assert.equal(first.filter((event) => event.type === "usage.update").length, 1);
  const retry = createProviderRuntime(config, { lifecycle, usageAccumulator }).transform(raw, ctx);
  assert.equal(retry.filter((event) => event.type === "usage.update").length, 0);
});

test("unclosed tools in session are closed with interrupted or cancelled status on finish", () => {
  const runtime = createProviderRuntime(
    { providerId: "grok", agent: "grok" },
    { transport: "acp" }
  );
  const ctx = { agent: "grok", invocationId: "inv-open-tools" };

  runtime.transform(
    {
      type: "acp.session_update",
      sessionId: "sess-1",
      update: {
        sessionUpdate: "session_info_update",
      },
    },
    ctx
  );

  runtime.transform(
    {
      type: "acp.session_update",
      sessionId: "sess-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-unfinished-1",
        name: "run_terminal_command",
        status: "in_progress",
        rawInput: { command: "npm test" },
      },
    },
    ctx
  );

  // Normal exit with unclosed tool -> status: "interrupted"
  const finishEvents = runtime.finish(ctx, {
    terminal: true,
    ok: false,
    error: "Child exited prematurely",
  });
  const finishedTool = finishEvents.find(
    (e) => e.type === "tool.finished" && e.toolId === "call-unfinished-1"
  );
  assert.ok(finishedTool, "tool.finished must be synthesized on finish for unclosed tool");
  assert.equal(finishedTool.status, "interrupted");
  assert.equal(finishedTool.failureSource, "lifecycle-terminal");

  // Second check: cancelled exit
  const runtime2 = createProviderRuntime(
    { providerId: "grok", agent: "grok" },
    { transport: "acp" }
  );
  runtime2.transform(
    {
      type: "acp.session_update",
      sessionId: "sess-2",
      update: {
        sessionUpdate: "session_info_update",
      },
    },
    ctx
  );
  runtime2.transform(
    {
      type: "acp.session_update",
      sessionId: "sess-2",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-unfinished-2",
        name: "fetch_data",
        status: "in_progress",
      },
    },
    ctx
  );
  const cancelEvents = runtime2.finish(ctx, {
    terminal: true,
    ok: false,
    stopReason: "explicit-stop",
  });
  const cancelledTool = cancelEvents.find(
    (e) => e.type === "tool.finished" && e.toolId === "call-unfinished-2"
  );
  assert.ok(cancelledTool, "tool.finished must be synthesized on cancel");
  assert.equal(cancelledTool.status, "cancelled");
});

test("ACP timeout closes child tools once, preserving their source and failure", () => {
  const runtime = createProviderRuntime(
    { providerId: "grok", agent: "grok" },
    { transport: "acp" }
  );
  const ctx = { agent: "grok", invocationId: "timeout-tools" };
  runtime.transform({ type: "acp.session_started", sessionId: "parent" }, ctx);
  const started = runtime
    .transform(
      {
        type: "acp.session_update",
        sessionId: "child",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "child-tool",
          name: "fetch_data",
          status: "in_progress",
        },
      },
      ctx
    )
    .find((e) => e.type === "tool.started");
  assert.ok(started);
  const events = runtime.finish(ctx, {
    terminal: true,
    ok: false,
    stopReason: "timeout",
    error: "Provider timed out",
  });
  const ends = events.filter((e) => e.type === "tool.finished");
  assert.equal(ends.length, 1);
  assert.equal(ends[0].status, "interrupted");
  assert.equal(ends[0].error, "Provider timed out");
  assert.equal(ends[0].sessionId, started.sessionId);
  assert.equal(ends[0].subagentId, started.subagentId);
  assert.equal(ends[0].toolId, started.toolId);
  assert.ok(
    events.findIndex((e) => e.type === "tool.finished") <
      events.findIndex((e) => e.type === "run.failed")
  );
  assert.deepEqual(runtime.finish(ctx, { terminal: true, ok: false }), []);
});
