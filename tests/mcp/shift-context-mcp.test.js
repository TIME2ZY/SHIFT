const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MEMORY_WRITE_TOOL,
  MEMORY_EVIDENCE_LIST_TOOL,
  RECALL_SEARCH_TOOL,
  callMemoryWrite,
  callMemoryEvidenceList,
  callRecallSearch,
  createRequestHandler,
} = require("../../scripts/shift-context-mcp");
const { shiftContextMcpConfigArgs } = require("../../src/agents/providers/codex");

const ENV = {
  SHIFT_API_URL: "http://127.0.0.1:8787",
  SHIFT_THREAD_ID: "thread-1",
  SHIFT_INVOCATION_ID: "invocation-1",
  SHIFT_CALLBACK_TOKEN: "secret",
};

test("shift context MCP exposes memory write and current evidence discovery", async () => {
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
  assert.deepEqual(listed.result.tools, [
    MEMORY_WRITE_TOOL,
    MEMORY_EVIDENCE_LIST_TOOL,
    RECALL_SEARCH_TOOL,
  ]);
  assert.deepEqual(MEMORY_WRITE_TOOL.inputSchema.required, ["kind", "topic", "content", "scope"]);
  assert.equal(MEMORY_WRITE_TOOL.inputSchema.additionalProperties, false);
});

test("shift context MCP returns structured recall results", async () => {
  const calls = [];
  const handle = createRequestHandler({
    recallSearch: async (args) => {
      calls.push(args);
      return {
        version: 2,
        query: args.query,
        hits: [{ id: "memory:1", layer: "memory", content: "SQLite is authoritative." }],
      };
    },
  });
  const response = await handle({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "recall_search",
      arguments: { query: "authoritative storage", layers: ["memory"], limit: 5 },
    },
  });
  assert.equal(response.result.isError, false);
  assert.equal(response.result.structuredContent.version, 2);
  assert.equal(response.result.structuredContent.hits[0].layer, "memory");
  assert.deepEqual(calls, [{ query: "authoritative storage", layers: ["memory"], limit: 5 }]);
});

test("recall_search bridge binds trusted context outside the agent arguments", async () => {
  let captured;
  const result = await callRecallSearch(
    { query: "why SQLite", layers: ["memory", "evidence"], limit: 8 },
    {
      env: ENV,
      fetchImpl: async (url, init) => {
        captured = { url, init };
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ version: 2, query: "why SQLite", hits: [] }),
        };
      },
    }
  );
  assert.equal(result.version, 2);
  assert.equal(captured.url.href, "http://127.0.0.1:8787/api/callbacks/recall-search");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers["X-Callback-Token"], "secret");
  assert.deepEqual(JSON.parse(captured.init.body), {
    sessionId: "thread-1",
    invocationId: "invocation-1",
    query: "why SQLite",
    layers: ["memory", "evidence"],
    limit: 8,
  });
  assert.equal(Object.hasOwn(JSON.parse(captured.init.body), "projectKey"), false);
});

test("shift context MCP returns current invocation evidence", async () => {
  const calls = [];
  const handle = createRequestHandler({
    memoryEvidenceList: async (args) => {
      calls.push(args);
      return {
        invocationId: "invocation-1",
        events: [{ eventNo: 7, kind: "tool.finished", summary: "tests passed" }],
        hasMore: false,
      };
    },
  });
  const response = await handle({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "memory_evidence_list",
      arguments: { limit: 5 },
    },
  });
  assert.equal(response.result.isError, false);
  assert.equal(response.result.structuredContent.events[0].eventNo, 7);
  assert.deepEqual(calls, [{ limit: 5 }]);
});

test("memory_evidence_list bridge binds current invocation credentials", async () => {
  let captured;
  const result = await callMemoryEvidenceList(
    { limit: 5 },
    {
      env: ENV,
      fetchImpl: async (url, init) => {
        captured = { url, init };
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              invocationId: "invocation-1",
              events: [{ eventNo: 4, kind: "tool.finished", summary: "ok" }],
              hasMore: false,
            }),
        };
      },
    }
  );
  assert.equal(result.events[0].eventNo, 4);
  assert.equal(
    captured.url.href,
    "http://127.0.0.1:8787/api/callbacks/memory-evidence" +
      "?sessionId=thread-1&invocationId=invocation-1&limit=5"
  );
  assert.equal(captured.init.method, "GET");
  assert.equal(captured.init.headers["X-Callback-Token"], "secret");
});

test("shift context MCP returns structured memory_write results", async () => {
  const calls = [];
  const handle = createRequestHandler({
    memoryWrite: async (args) => {
      calls.push(args);
      return { outcome: "created", memoryId: "memory-1", status: "active" };
    },
  });
  const response = await handle({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "memory_write",
      arguments: {
        kind: "fact",
        topic: "runtime.sqlite-version",
        content: "SQLite version 3.50 is available.",
        scope: "thread",
        evidenceEventNo: 7,
      },
    },
  });
  assert.equal(response.result.isError, false);
  assert.equal(response.result.structuredContent.outcome, "created");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].evidenceEventNo, 7);
});

test("memory_write bridge binds callback credentials from environment", async () => {
  let captured;
  const result = await callMemoryWrite(
    {
      kind: "fact",
      topic: "runtime.database",
      content: "SQLite is available at runtime.",
      scope: "thread",
      evidenceEventNo: 4,
    },
    {
      env: ENV,
      fetchImpl: async (url, init) => {
        captured = { url, init };
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ outcome: "created", memoryId: "memory-1" }),
        };
      },
    }
  );
  assert.equal(result.outcome, "created");
  assert.equal(captured.url.href, "http://127.0.0.1:8787/api/callbacks/memory-write");
  assert.equal(captured.init.headers["X-Callback-Token"], "secret");
  assert.deepEqual(JSON.parse(captured.init.body), {
    sessionId: "thread-1",
    invocationId: "invocation-1",
    callbackToken: "secret",
    kind: "fact",
    topic: "runtime.database",
    content: "SQLite is available at runtime.",
    scope: "thread",
    evidenceEventNo: 4,
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
  assert.ok(args.some((value) => value.startsWith("mcp_servers.shift_context.command=")));
  assert.ok(
    args.some(
      (value) =>
        value.startsWith("mcp_servers.shift_context.args=") &&
        value.includes("shift-context-mcp.js")
    )
  );
  assert.ok(
    args.includes(
      'mcp_servers.shift_context.enabled_tools=["memory_write","memory_evidence_list","recall_search"]'
    )
  );
  assert.ok(args.some((value) => value.includes("SHIFT_CALLBACK_TOKEN")));
});
