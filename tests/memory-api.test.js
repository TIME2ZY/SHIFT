const assert = require("node:assert/strict");
const test = require("node:test");

const memoryApi = require("../public/memory-api.js");

function jsonResponse(payload) {
  const text = JSON.stringify(payload);
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => text,
    json: async () => payload,
  };
}

test("memory api builds list and mutation requests", async () => {
  const calls = [];
  const api = memoryApi.createMemoryApi(async (url, init = {}) => {
    calls.push({ url, init });
    if (String(url).includes("/confirm")) {
      return jsonResponse({ memory: { id: "m1", status: "active" } });
    }
    if (String(url).startsWith("/api/memories?") || url === "/api/memories") {
      return jsonResponse({ memories: [{ id: "m1" }], counts: { active: 1 } });
    }
    return jsonResponse({ memory: { id: "m1", status: "active" }, created: true });
  });

  const listed = await api.listMemories("session-1", { kind: "decision", includeRetired: true });
  assert.equal(listed.memories.length, 1);
  assert.match(calls[0].url, /sessionId=session-1/);
  assert.match(calls[0].url, /kind=decision/);

  await api.createMemory({ sessionId: "session-1", kind: "fact", content: "x" });
  assert.equal(calls[1].init.method, "POST");

  await api.confirmMemory("m1");
  assert.match(calls[2].url, /\/confirm$/);
});
