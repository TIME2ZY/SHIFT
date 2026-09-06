const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { resolveGrokCommand } = require("../../src/agents/providers/grok");
const { AGENTS, getAgentModelProfile } = require("../../src/agents/catalog");
const { buildInvocation } = require("../../src/agents/invoke-cli");
const {
  createProviderRuntime,
  listSupportedProviders,
  getProviderAdapter,
  getProviderTransportAdapter,
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
  assert.equal(AGENTS.grok.transport, "acp");
  assert.equal(AGENTS.grok.capacityTokens, undefined);
  assert.equal(getAgentModelProfile("grok").contextTokens, 500_000);
});

test("buildInvocation for grok uses ACP stdio, not streaming-json", () => {
  const inv = buildInvocation(AGENTS.grok, "hello world");
  assert.match(String(inv.command), /grok(\.exe)?$/i);
  assert.ok(inv.args.includes("agent"));
  assert.ok(inv.args.includes("--no-leader"));
  assert.ok(inv.args.includes("stdio"));
  assert.ok(inv.args.includes("-m"));
  assert.ok(inv.args.includes("grok-4.6"));
  assert.ok(inv.args.includes("--reasoning-effort"));
  assert.ok(inv.args.includes("high"));
  assert.ok(inv.args.includes("--always-approve"));
  assert.ok(!inv.args.includes("-p"));
  assert.ok(!inv.args.includes("hello world"));
  assert.ok(!inv.args.includes("streaming-json"));
  assert.ok(!inv.args.includes("--no-subagents"));
});

test("grok adapter is ACP-only and rejects CLI transport", () => {
  const adapter = getProviderAdapter("grok");
  assert.equal(adapter.protocol, "acp");
  assert.equal(adapter.capabilities.thinking, true);
  assert.equal(adapter.capabilities.tools, true);
  assert.equal(adapter.capabilities.resume, true);
  assert.equal(adapter.cliCapabilities, undefined);
  assert.equal(getProviderTransportAdapter(AGENTS.grok).id, "grok");
  assert.throws(
    () => getProviderTransportAdapter(AGENTS.grok, "cli"),
    /does not support transport "cli"/
  );
});

test("unknown grok providerOptions fail instead of mapping CLI flags", () => {
  assert.throws(
    () =>
      buildInvocation(
        {
          ...AGENTS.grok,
          providerOptions: { noSubagents: true },
        },
        "x"
      ),
    /Unknown providerOptions for "grok": noSubagents/
  );
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

test("Grok resume stays on ACP session load, not CLI -r", () => {
  const inv = buildInvocation(
    { ...AGENTS.grok, resumeSessionId: "019f50e8-88a0-7ee1-b525-df3b193ced6b" },
    "continue"
  );
  assert.ok(!inv.args.includes("-r"));
  assert.ok(inv.args.includes("stdio"));
});

test("buildInvocation passes unknown grok models through to ACP", () => {
  const inv = buildInvocation(
    { providerId: "grok", model: "grok-nope", reasoningEffort: "high" },
    "x"
  );
  assert.ok(inv.args.includes("-m"));
  assert.ok(inv.args.includes("grok-nope"));
  assert.ok(inv.args.includes("stdio"));
});

test("resolveGrokCommand returns a string", () => {
  const cmd = resolveGrokCommand();
  assert.equal(typeof cmd, "string");
  assert.ok(cmd.length > 0);
});

test("identity file exists for grok and mentions ACP", () => {
  const file = path.join(__dirname, "../../src/agents/identities/grok.md");
  assert.ok(fs.existsSync(file));
  const body = fs.readFileSync(file, "utf8");
  assert.match(body, /id: grok/);
  assert.match(body, /Grok ACP/);
  assert.doesNotMatch(body, /CLI\/ACP/);
});
