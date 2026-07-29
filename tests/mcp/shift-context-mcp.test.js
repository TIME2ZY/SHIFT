const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MEMORY_WRITE_TOOL,
  callMemoryWrite,
  createRequestHandler,
} = require("../../scripts/shift-context-mcp");
const {
  shiftContextMcpConfigArgs,
} = require("../../src/agents/providers/codex");

const ENV = {
  SHIFT_API_URL: "http://127.0.0.1:8787",
  SHIFT_THREAD_ID: "thread-1",
  SHIFT_INVOCATION_ID: "invocation-1",
  SHIFT_CALLBACK_TOKEN: "secret",
};

test("shift context MCP exposes only memory_write", async () => {
  const handle = createRequestHandler();
  const initialized = await handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  });
  assert.equal(initialized.result.serverInfo.name, "shift-context");
  assert.equal(initialized.result.capabilities.tools.listChanged, false);

  const listed = await handle({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  });
  assert.deepEqual(listed.result.tools, [MEMORY_WRITE_TOOL]);
  assert.deepEqual(MEMORY_WRITE_TOOL.inputSchema.required, [
    "kind",
    "topic",
    "content",
    "scope",
  ]);
  assert.equal(MEMORY_WRITE_TOOL.inputSchema.additionalProperties, false);
});

test("shift context MCP returns structured memory_write results", async () => {
  const calls = [];
  const handle = createRequestHandler({
    memoryWrite: async (args) => {
      calls.push(args);
      return { outcome: "created", memoryId: "memory-1", status: "captured" };
    },
  });
  const response = await handle({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "memory_write",
      arguments: {
        kind: "decision",
        topic: "storage.authoritative",
        content: "SQLite is authoritative.",
        scope: "project",
      },
    },
  });
  assert.equal(response.result.isError, false);
  assert.equal(response.result.structuredContent.outcome, "created");
  assert.equal(calls.length, 1);
});

test("memory_write bridge binds callback credentials from environment", async () => {
  let captured;
  const result = await callMemoryWrite(
    {
      kind: "fact",
      topic: "runtime.database",
      content: "SQLite is available at runtime.",
      scope: "thread",
    },
    {
      env: ENV,
      fetchImpl: async (url, init) => {
        captured = { url, init };
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({ outcome: "created", memoryId: "memory-1" }),
        };
      },
    }
  );
  assert.equal(result.outcome, "created");
  assert.equal(
    captured.url.href,
    "http://127.0.0.1:8787/api/callbacks/memory-write"
  );
  assert.equal(captured.init.headers["X-Callback-Token"], "secret");
  assert.deepEqual(JSON.parse(captured.init.body), {
    sessionId: "thread-1",
    invocationId: "invocation-1",
    callbackToken: "secret",
    kind: "fact",
    topic: "runtime.database",
    content: "SQLite is available at runtime.",
    scope: "thread",
  });
});

test("memory_write bridge returns policy rejection without an MCP transport error", async () => {
  const result = await callMemoryWrite(
    {
      kind: "fact",
      topic: "runtime.database",
      content: "SQLite is available at runtime.",
      scope: "thread",
    },
    {
      env: ENV,
      fetchImpl: async () => ({
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({
            outcome: "rejected",
            code: "invalid_candidate",
            reason: "Evidence is missing.",
          }),
      }),
    }
  );
  assert.deepEqual(result, {
    outcome: "rejected",
    code: "invalid_candidate",
    reason: "Evidence is missing.",
  });
});

test("Codex invocation config registers the per-invocation MCP bridge", () => {
  const args = shiftContextMcpConfigArgs();
  assert.ok(
    args.some((value) =>
      value.startsWith("mcp_servers.shift_context.command=")
    )
  );
  assert.ok(
    args.some(
      (value) =>
        value.startsWith("mcp_servers.shift_context.args=") &&
        value.includes("shift-context-mcp.js")
    )
  );
  assert.ok(
    args.includes(
      'mcp_servers.shift_context.enabled_tools=["memory_write"]'
    )
  );
  assert.ok(
    args.some((value) => value.includes("SHIFT_CALLBACK_TOKEN"))
  );
});
