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
    ["run.started", "text.delta"]
  );
  assert.ok(first.every((e) => e.protocolVersion === PROTOCOL_VERSION));

  const finished = runtime.finish(ctx, { terminal: true, ok: true, exitCode: 0 });
  assert.deepEqual(
    finished.map((e) => e.type),
    ["run.finished"]
  );

  const late = runtime.transform(
    { type: "item.completed", item: { type: "agent_message", text: "late" } },
    ctx
  );
  assert.deepEqual(late, []);
  assert.deepEqual(runtime.finish(ctx, { terminal: true, ok: true, exitCode: 0 }), []);
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
    ["run.started", "text.delta"]
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
    ["text.delta"]
  );
  assert.equal(second[0].text, "b");
  assert.deepEqual(
    attempt2.finish(ctx, { terminal: true, ok: true, exitCode: 0 }).map((e) => e.type),
    ["run.finished"]
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
