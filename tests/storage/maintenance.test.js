const assert = require("node:assert/strict");
const test = require("node:test");

const { createStorage } = require("../../src/storage");
const {
  integrityCheck,
  checkpoint,
  rebuildThreadRecall,
  rebuildAllRecall,
  rebuildDerivedModels,
  rebuildFts,
} = require("../../src/storage/maintenance");

test("maintenance rebuild helpers reindex a thread and FTS", () => {
  const storage = createStorage({ file: ":memory:" });
  try {
    storage.threads.create({ id: "thread-1" });
    storage.messages.append({
      id: "m1",
      threadId: "thread-1",
      role: "user",
      content: "searchable maintenance token",
    });
    const rebuilt = rebuildThreadRecall(storage, "thread-1");
    assert.equal(rebuilt.messages, 1);
    assert.equal(storage.recall.search("thread-1", "maintenance token").length, 1);

    const all = rebuildAllRecall(storage);
    assert.equal(all.threads, 1);
    const fts = rebuildFts(storage);
    assert.ok(fts.items >= 1);

    assert.equal(integrityCheck(storage.db).ok, true);
    assert.ok(Array.isArray(checkpoint(storage.db, "PASSIVE")));
  } finally {
    storage.close();
  }
});

test("all derived models rebuild from SQLite source tables", () => {
  const storage = createStorage({ file: ":memory:" });
  try {
    storage.threads.create({ id: "thread-1" });
    storage.messages.append({
      id: "message-1",
      threadId: "thread-1",
      role: "user",
      content: "derived rebuild message",
    });
    storage.memories.create({
      id: "memory-1",
      threadId: "thread-1",
      kind: "decision",
      content: "derived rebuild memory",
      createdBy: "codex",
      captureKey: "decision:rebuild:1",
      supersessionKey: "decision:rebuild",
      authority: "agent",
      activation: "query",
    });

    storage.db.prepare("DELETE FROM recall_items").run();
    storage.db.prepare("DELETE FROM memory_search").run();
    storage.db.prepare("DELETE FROM thread_digests").run();

    const rebuilt = rebuildDerivedModels(storage);
    assert.equal(rebuilt.threads, 1);
    assert.equal(rebuilt.recall[0].messages, 1);
    assert.equal(rebuilt.memorySearch.memories, 1);
    assert.equal(rebuilt.digests, 1);
    assert.equal(storage.recall.search("thread-1", "rebuild message").length, 1);
    assert.equal(
      storage.memories.searchMemory("rebuild memory", {
        threadId: "thread-1",
        scope: "all",
      }).length,
      1
    );
    assert.equal(storage.digests.get("thread-1").messageCount, 1);
  } finally {
    storage.close();
  }
});
