const assert = require("node:assert/strict");
const test = require("node:test");

const { createStorage } = require("../../src/storage");

function seedThread(storage) {
  storage.threads.create({ id: "thread-1" });
  storage.windows.create({
    id: "window-1",
    threadId: "thread-1",
    agentId: "codex",
    providerKey: "codex:gpt-5.6-sol",
    workspaceKey: "base:C:/repo",
    generation: 1,
    capacityTokens: 200000,
  });
}

test("recall repository supports exact, FTS, CJK contains, and source filters", () => {
  const storage = createStorage({ file: ":memory:" });
  try {
    seedThread(storage);
    storage.recall.upsert({
      threadId: "thread-1",
      windowId: "window-1",
      sourceKind: "message",
      sourceId: "message-1",
      title: "SQLite decision",
      content: "Use SQLite as durable memory storage",
      createdAt: "2026-07-12T00:00:00.000Z",
      metadata: { role: "assistant" },
    });
    storage.recall.upsert({
      threadId: "thread-1",
      sourceKind: "memory-entry",
      sourceId: "memory-1",
      title: "检索设计",
      content: "保留跨窗口记忆检索能力",
      createdAt: "2026-07-12T00:00:01.000Z",
    });

    assert.equal(storage.recall.search("thread-1", "message-1")[0].sourceId, "message-1");
    assert.equal(storage.recall.search("thread-1", "durable")[0].sourceId, "message-1");
    assert.equal(storage.recall.search("thread-1", "跨窗口记忆")[0].sourceId, "memory-1");
    assert.equal(
      storage.recall.search("thread-1", "SQLite", { sourceKinds: ["memory-entry"] }).length,
      0
    );
    assert.equal(storage.recall.search("thread-1", "%").length, 0);
    assert.deepEqual(storage.recall.getBySource("message", "message-1").metadata, {
      role: "assistant",
    });
  } finally {
    storage.close();
  }
});

test("recall upsert updates the FTS projection without duplicate rows", () => {
  const storage = createStorage({ file: ":memory:" });
  try {
    seedThread(storage);
    const base = {
      threadId: "thread-1",
      sourceKind: "message",
      sourceId: "message-1",
      title: "Old",
      content: "old searchable text",
    };
    storage.recall.upsert(base);
    storage.recall.upsert({ ...base, title: "New", content: "replacement content" });

    assert.equal(storage.recall.search("thread-1", "old searchable").length, 0);
    assert.equal(storage.recall.search("thread-1", "replacement").length, 1);
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM recall_items").get().count, 1);
  } finally {
    storage.close();
  }
});

test("rebuildThread indexes event plain text instead of raw JSON payload shells", () => {
  const storage = createStorage({ file: ":memory:" });
  try {
    seedThread(storage);
    storage.invocations.start({
      id: "invocation-1",
      threadId: "thread-1",
      windowId: "window-1",
      agentId: "codex",
    });
    storage.invocations.appendEvent({
      invocationId: "invocation-1",
      sequenceNo: 0,
      kind: "text.delta",
      payload: { text: "readable delta body", nested: { a: 1 } },
    });
    storage.invocations.appendEvent({
      invocationId: "invocation-1",
      sequenceNo: 1,
      kind: "handoff",
      payload: { what: "实现登录", why: "鉴权", next_action: "测一下", to: "opencode" },
    });
    storage.recall.rebuildThread("thread-1");

    const delta = storage.recall.getBySource("invocation-event", "invocation-1:0");
    const handoff = storage.recall.getBySource("invocation-event", "invocation-1:1");
    assert.equal(delta.content, "readable delta body");
    assert.doesNotMatch(delta.content, /"nested"/);
    assert.match(handoff.content, /what: 实现登录/);
    assert.doesNotMatch(handoff.content, /\{"what"/);

    const hits = storage.recall.search("thread-1", "readable delta");
    assert.equal(hits[0].sourceId, "invocation-1:0");
  } finally {
    storage.close();
  }
});

test("recall projection can be rebuilt from durable source tables", () => {
  const storage = createStorage({ file: ":memory:" });
  try {
    seedThread(storage);
    storage.messages.append({
      id: "message-1",
      threadId: "thread-1",
      windowId: "window-1",
      sequenceNo: 0,
      role: "user",
      content: "rebuild message",
    });
    storage.invocations.start({
      id: "invocation-1",
      threadId: "thread-1",
      windowId: "window-1",
      agentId: "codex",
    });
    storage.invocations.appendEvent({
      invocationId: "invocation-1",
      sequenceNo: 0,
      kind: "tool.completed",
      payload: { result: "rebuild event" },
    });
    storage.memories.create({
      id: "memory-1",
      threadId: "thread-1",
      kind: "decision",
      content: "rebuild memory",
      createdBy: "codex",
      windowId: "window-1",
      captureKey: "decision:memory-1",
      supersessionKey: "decision:storage",
      metadata: { quality: { ok: true } },
    });

    const result = storage.recall.rebuildThread("thread-1");
    // L2 memories project via memory_search, not recall_items.
    assert.deepEqual(result, { messages: 1, events: 1, memories: 0 });
    assert.equal(storage.recall.search("thread-1", "rebuild").length, 2);
    const rebuiltMemory = storage.memories.getSearchProjection("memory-1");
    assert.ok(rebuiltMemory);
    assert.equal(rebuiltMemory.metadata.captureKey, "decision:memory-1");
    assert.equal(rebuiltMemory.metadata.supersessionKey, "decision:storage");
    assert.deepEqual(rebuiltMemory.metadata.quality, { ok: true });
  } finally {
    storage.close();
  }
});
