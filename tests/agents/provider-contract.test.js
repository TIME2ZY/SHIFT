const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PROVIDERS,
  assertProviderAdapter,
  buildProviderInvocation,
  createProviderRuntime,
  resolveProviderRunOptions,
  buildProviderEnvironment,
  getProviderDiagnostics,
  collectProviderStartupDiagnostics,
  validateProviderConfig,
} = require("../../src/agents/providers");
const { MODEL_PROFILES, getModelProfile } = require("../../src/agents/catalog");
const {
  assertCanonicalEvent,
  normalizeCanonicalEvent,
  validateCanonicalEvent,
} = require("../../src/agents/event-protocol");
const fs = require("node:fs");
const path = require("node:path");

const CONFIGS = {
  codex: { providerId: "codex", model: "gpt-5.6-sol", reasoningEffort: "medium" },
  opencode: { providerId: "opencode", model: "qwen3.7-plus" },
  grok: { providerId: "grok", model: "grok-4.5", reasoningEffort: "high" },
  antigravity: {
    providerId: "antigravity",
    model: "gemini-3.5-flash",
    reasoningEffort: "high",
  },
};

test("every provider implements the complete adapter contract", () => {
  for (const [providerId, adapter] of Object.entries(PROVIDERS)) {
    assert.equal(assertProviderAdapter(adapter), adapter);
    assert.equal(adapter.id, providerId);
    assert.equal(typeof adapter.capabilities.resume, "boolean");
    assert.equal(typeof adapter.capabilities.thinking, "boolean");
    assert.ok(Array.isArray(adapter.allowedProviderOptions));

    const invocation = buildProviderInvocation(CONFIGS[providerId], "hello");
    assert.equal(typeof invocation.command, "string");
    assert.ok(Array.isArray(invocation.args));

    const runtime = createProviderRuntime(CONFIGS[providerId]);
    assert.equal(typeof runtime.transform, "function");
    assert.equal(typeof runtime.extractSessionId, "function");
    assert.equal(typeof runtime.finish, "function");
    if (adapter.classifyStderr) assert.equal(typeof runtime.classifyStderr, "function");
    assert.ok(Array.isArray(runtime.finish({ agent: "a", invocationId: "i" })));

    const envBundle = buildProviderEnvironment(CONFIGS[providerId], { proxy: "" }, {});
    assert.equal(typeof envBundle.env, "object");
    assert.ok(Array.isArray(getProviderDiagnostics(CONFIGS[providerId], { proxy: "" }, {})));
  }
});

test("all active providers advertise canonical usage support", () => {
  for (const adapter of Object.values(PROVIDERS)) {
    assert.equal(adapter.capabilities.usage, true, `${adapter.id} should expose usage`);
  }
});

test("unknown providers fail fast instead of falling through to Codex", () => {
  assert.throws(
    () => buildProviderInvocation({ providerId: "claude", model: "x" }, "hello"),
    /Unsupported provider "claude"/
  );
});

test("model catalog separates execution provider from model vendor", () => {
  const qwen = getModelProfile("opencode", "qwen3.7-plus");
  assert.equal(qwen.providerId, "opencode");
  assert.equal(qwen.vendorId, "alibaba");
  const codex = getModelProfile("codex", "gpt-5.6-sol");
  assert.equal(codex.providerId, "codex");
  assert.equal(codex.vendorId, "openai");
  assert.ok(MODEL_PROFILES.every((profile) => profile.contextTokens > 0));
});

test("canonical event validator rejects missing fields and unknown event types", () => {
  const missing = validateCanonicalEvent({ type: "text.delta", text: "hello" });
  assert.ok(missing.includes("text.delta.agent is required"));
  assert.ok(missing.includes("text.delta.invocationId is required"));
  assert.throws(() => assertCanonicalEvent({ type: "vendor.magic" }), /unsupported event type/);
  const ok = assertCanonicalEvent({
    type: "text.delta",
    agent: "codex",
    invocationId: "inv-1",
    text: "hello",
  });
  assert.equal(ok.protocolVersion, 2);
  assert.equal(typeof ok.text, "string");
});

test("runtime envelope enforces started-before-content and one terminal event", () => {
  const runtime = createProviderRuntime(CONFIGS.codex);
  const context = { agent: "codex", invocationId: "inv-life" };
  const content = runtime.transform(
    {
      type: "item.completed",
      item: { type: "agent_message", text: "hello" },
    },
    context
  );
  assert.deepEqual(
    content.map((event) => event.type),
    ["run.started", "text.delta"]
  );
  assert.deepEqual(
    runtime.finish(context, { terminal: true, ok: true, exitCode: 0 }).map((event) => event.type),
    ["run.finished"]
  );
  assert.deepEqual(runtime.finish(context, { terminal: true, ok: true }), []);
});

test("provider options configure adapters without central provider branches", () => {
  const opencode = buildProviderInvocation(
    {
      ...CONFIGS.opencode,
      providerOptions: { thinking: false, modelPrefix: "custom/" },
    },
    "hello"
  );
  assert.equal(opencode.args.includes("--thinking"), false);
  assert.ok(opencode.args.includes("custom/qwen3.7-plus"));

  const grok = buildProviderInvocation(
    {
      ...CONFIGS.grok,
      providerOptions: { alwaysApprove: false, autoUpdate: true },
    },
    "hello"
  );
  assert.equal(grok.args.includes("--always-approve"), false);
  assert.equal(grok.args.includes("--no-auto-update"), false);
});

test("provider adapter owns provider-specific proxy precedence", () => {
  const options = resolveProviderRunOptions(
    CONFIGS.grok,
    { proxy: "", providerOptions: {} },
    { GROK_PROXY: "http://grok:1", HTTPS_PROXY: "http://global:1" }
  );
  assert.equal(options.proxy, "http://grok:1");
});

test("progress and tool events expose canonical state fields", () => {
  const progress = normalizeCanonicalEvent({
    type: "progress.update",
    items: [{ text: "Build", done: true }],
  });
  assert.deepEqual(progress.items[0], {
    text: "Build",
    done: true,
    id: "step-1",
    label: "Build",
    status: "completed",
  });
  assert.equal(normalizeCanonicalEvent({ type: "tool.finished", status: "error" }).state, "failed");
});

test("unknown providerOptions fail fast with allowed field names", () => {
  assert.throws(
    () =>
      validateProviderConfig({
        ...CONFIGS.opencode,
        providerOptions: { thinkng: false },
      }),
    /Unknown providerOptions for "opencode": thinkng/
  );
});

test("non-object providerOptions fail fast instead of becoming empty object", () => {
  assert.throws(
    () =>
      validateProviderConfig({
        ...CONFIGS.codex,
        providerOptions: "danger-full-access",
      }),
    /must be a plain object/
  );
  assert.throws(
    () =>
      validateProviderConfig({
        ...CONFIGS.codex,
        providerOptions: 1,
      }),
    /must be a plain object/
  );
});

test("grok adapter owns missing-proxy diagnostics and GROK_PROXY env patch", () => {
  const messages = getProviderDiagnostics(CONFIGS.grok, { proxy: "" }, {});
  assert.ok(messages.some((line) => /no proxy for grok/i.test(line)));

  const { env } = buildProviderEnvironment(
    CONFIGS.grok,
    { proxy: "" },
    { GROK_PROXY: "http://127.0.0.1:7892" }
  );
  assert.equal(env.GROK_PROXY, "http://127.0.0.1:7892");
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:7892");
});

test("provider adapter rejects a non-function stderr classifier", () => {
  assert.throws(
    () =>
      assertProviderAdapter({
        id: "broken",
        capabilities: {},
        allowedProviderOptions: [],
        createRuntime() {},
        buildInvocation() {},
        classifyStderr: true,
      }),
    /classifyStderr must be a function/
  );
});

test("provider startup diagnostics are opt-in", () => {
  const proxyEnv = { INVOKE_CLI_PROXY: "http://127.0.0.1:7892" };
  assert.deepEqual(collectProviderStartupDiagnostics(proxyEnv), []);

  const messages = collectProviderStartupDiagnostics({
    ...proxyEnv,
    INVOKE_CLI_PROXY_LOG: "1",
  });
  assert.ok(messages.some((line) => line.includes("CLI proxy: http://127.0.0.1:7892")));
});

test("invoke-cli entry stays free of provider special cases and server imports", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../src/agents/invoke-cli.js"), "utf8");
  assert.doesNotMatch(source, /providerId\s*===\s*["']grok["']/);
  assert.doesNotMatch(source, /require\(["']\.\.\/server\//);
  assert.doesNotMatch(source, /extractAssistantText/);
});

test("server entry does not hardcode grok proxy resolution", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../src/server/index.js"), "utf8");
  assert.doesNotMatch(source, /resolveProviderProxy\(\s*["']grok["']\s*\)/);
  assert.match(source, /collectProviderStartupDiagnostics/);
});
