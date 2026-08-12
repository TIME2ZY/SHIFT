const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  SHIFT_CONTEXT_ENV_KEYS,
  createShiftContextStdioDescriptor,
  createOpencodeShiftContextConfig,
  createAcpShiftContextServer,
  ensureAntigravityShiftContextConfig,
} = require("../../src/agents/shift-context-mcp-config");

test("shared Shift MCP descriptor exposes one server and the trusted environment", () => {
  const descriptor = createShiftContextStdioDescriptor();
  assert.equal(descriptor.name, "shift_context");
  assert.equal(descriptor.command, process.execPath);
  assert.match(descriptor.args[0], /shift-context-mcp\.js$/);
  assert.deepEqual(descriptor.envKeys, [...SHIFT_CONTEXT_ENV_KEYS]);
  assert.deepEqual(descriptor.tools, ["memory_write", "memory_evidence_list", "recall_search"]);
});

test("OpenCode inline config preserves existing settings and registers Shift MCP", () => {
  const config = JSON.parse(
    createOpencodeShiftContextConfig(JSON.stringify({ snapshot: false, mcp: { other: {} } }))
  );
  assert.equal(config.snapshot, false);
  assert.deepEqual(config.mcp.other, {});
  assert.equal(config.mcp.shift_context.type, "local");
  assert.equal(config.mcp.shift_context.command[0], process.execPath);
  assert.match(config.mcp.shift_context.command[1], /shift-context-mcp\.js$/);
  assert.equal(config.mcp.shift_context.enabled, true);
});

test("Antigravity registration preserves other servers and stores no invocation secret", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "shift-agy-mcp-"));
  try {
    const configDir = path.join(home, ".gemini", "config");
    fs.mkdirSync(configDir, { recursive: true });
    const file = path.join(configDir, "mcp_config.json");
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { other: { serverUrl: "https://x" } } }));

    ensureAntigravityShiftContextConfig({ USERPROFILE: home });
    const raw = fs.readFileSync(file, "utf8");
    const config = JSON.parse(raw);
    assert.deepEqual(config.mcpServers.other, { serverUrl: "https://x" });
    assert.equal(config.mcpServers.shift_context.command, process.execPath);
    assert.match(config.mcpServers.shift_context.args[0], /shift-context-mcp\.js$/);
    assert.doesNotMatch(raw, /SHIFT_CALLBACK_TOKEN|probe-token/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("ACP descriptor carries current invocation credentials without persistence", () => {
  const env = Object.fromEntries(SHIFT_CONTEXT_ENV_KEYS.map((name) => [name, `value-${name}`]));
  const server = createAcpShiftContextServer(env);
  assert.equal(server.name, "shift_context");
  assert.equal(server.command, process.execPath);
  assert.match(server.args[0], /shift-context-mcp\.js$/);
  assert.deepEqual(
    server.env,
    SHIFT_CONTEXT_ENV_KEYS.map((name) => ({ name, value: env[name] }))
  );
});
