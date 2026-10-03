"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { applyReadOnlyPermissions } = require("../../src/agents/invocation-permissions");
const { getProviderAdapter } = require("../../src/agents/providers");
test("Codex preparation uses read-only sandbox; Claude exposes only read tools without configured MCP", () => {
  for (const purpose of ["prepare", "materials"]) {
    const env = { INVOKE_PURPOSE: purpose };
    const codex = getProviderAdapter("codex").buildInvocation(
      applyReadOnlyPermissions({ providerId: "codex" }, env),
      "prepare"
    );
    assert.deepEqual(codex.args.slice(0, 4), ["-s", "read-only", "-a", "never"]);
    assert.equal(codex.args.at(-1), "-");
    assert.ok(codex.args.includes("--skip-git-repo-check"));
    assert.equal(codex.stdinText, "prepare");
    const claude = getProviderAdapter("claude").buildInvocation(
      applyReadOnlyPermissions({ providerId: "claude" }, env),
      "prepare"
    );
    assert.equal(claude.args[claude.args.indexOf("--tools") + 1], "Read,Glob,Grep");
    assert.ok(claude.args.includes("--strict-mcp-config"));
    assert.equal(claude.args[claude.args.indexOf("--mcp-config") + 1], '{"mcpServers":{}}');
    assert.equal(claude.stdinText, "prepare");
    assert.throws(() => applyReadOnlyPermissions({ providerId: "other" }, env), /cannot enforce/);
  }
});
