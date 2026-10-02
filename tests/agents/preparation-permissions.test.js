"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { applyPreparationPermissions } = require("../../src/agents/preparation-permissions");
const { getProviderAdapter } = require("../../src/agents/providers");
test("Codex preparation uses read-only sandbox; Claude exposes only read tools without configured MCP", () => {
  const env = { INVOKE_PURPOSE: "prepare" };
  const codex = getProviderAdapter("codex").buildInvocation(
    applyPreparationPermissions({ providerId: "codex" }, env),
    "prepare"
  );
  assert.deepEqual(codex.args.slice(0, 4), ["-s", "read-only", "-a", "never"]);
  const claude = getProviderAdapter("claude").buildInvocation(
    applyPreparationPermissions({ providerId: "claude" }, env),
    "prepare"
  );
  assert.equal(claude.args[claude.args.indexOf("--tools") + 1], "Read,Glob,Grep");
  assert.ok(claude.args.includes("--strict-mcp-config"));
  assert.equal(claude.args[claude.args.indexOf("--mcp-config") + 1], '{"mcpServers":{}}');
  assert.throws(() => applyPreparationPermissions({ providerId: "other" }, env), /cannot enforce/);
});
