const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createStorage } = require("../../src/storage");
const { createRecallService } = require("../../src/storage/recall-service");
const { buildActiveMemoryCard } = require("../../src/session/bootstrap");
const { PROJECT_SCOPE_RETIRED_MESSAGE } = require("../../src/storage/memory-service");

function emptyTranscript() {
  return {
    listInvocationsWithMeta: async () => [],
    searchTranscript: async () => [],
    readInvocationPage: async () => ({ events: [], total: 0, from: 0, limit: 200 }),
  };
}

function createProjectFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shift-xthread-"));
  const storage = createStorage({ file: ":memory:" });
  storage.threads.create({ id: "thread-a", projectDir: dir, title: "A" });
  storage.threads.create({ id: "thread-b", projectDir: dir, title: "B" });
  return { storage, dir };
}

test("decision is thread-only and not injected into sibling thread", async () => {
  const { storage, dir } = createProjectFixture();
  try {
    const threadA = storage.threads.get("thread-a");
    const threadB = storage.threads.get("thread-b");
    assert.ok(threadA.projectKey);
    assert.equal(threadA.projectKey, threadB.projectKey);

    const written = storage.memory.createProduct({
      threadId: "thread-a",
      kind: "decision",
      topic: "storage-primary",
      content: "在线读写以 SQLite 为准",
      createdBy: "user",
      writeChannel: "user",
    });
    assert.equal(written.scope, "thread");
    assert.equal(written.memory.scope, "thread");
    assert.equal(written.memory.ownerThreadId, "thread-a");
    assert.equal(written.memory.projectKey, null);

    const forB = storage.memory.listActiveForTurn("thread-b", { limit: 20 });
    assert.equal(
      forB.some((m) => m.id === written.memory.id),
      false
    );

    const forA = storage.memory.listActiveForTurn("thread-a", { limit: 20 });
    assert.ok(forA.some((m) => m.id === written.memory.id));

    const service = createRecallService({ storage, transcript: emptyTranscript() });
    const packB = await service.retrieveForTurn({
      threadId: "thread-b",
      prompt: "SQLite 存储怎么定的？",
      budgetChars: 3000,
    });
    assert.equal(
      packB.items.some((m) => m.id === written.memory.id),
      false
    );

    const packA = await service.retrieveForTurn({
      threadId: "thread-a",
      prompt: "SQLite 存储怎么定的？",
      budgetChars: 3000,
    });
    assert.ok(packA.items.some((m) => m.id === written.memory.id));
    assert.match(packA.rendered, /SQLite/);

    const agentResult = await service.searchForAgent(
      { threadId: "thread-a", invocationId: "invocation-a", caller: "mcp" },
      { query: "SQLite 存储", layers: ["memory"], memoryScope: "thread" }
    );
    const hit = agentResult.hits.find((h) => h.source.memoryId === written.memory.id);
    assert.ok(hit);
    assert.equal(hit.metadata.scope, "thread");

    const cardB = await buildActiveMemoryCard({
      threadId: "thread-b",
      prompt: "继续",
      retrieveSource: service,
      memorySource: storage.memory,
    });
    assert.equal(
      cardB.items.some((m) => m.id === written.memory.id),
      false
    );
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("createProduct rejects project scope", () => {
  const { storage, dir } = createProjectFixture();
  try {
    assert.throws(
      () =>
        storage.memory.createProduct({
          threadId: "thread-a",
          kind: "decision",
          topic: "storage-primary",
          content: "must not become project memory",
          createdBy: "user",
          scope: "project",
        }),
      (error) => String(error.message).includes("Project-scoped memory is retired")
    );
    assert.match(PROJECT_SCOPE_RETIRED_MESSAGE, /docs\//);
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy active project memory is not durable-searchable from sibling thread", async () => {
  const { storage, dir } = createProjectFixture();
  try {
    const threadA = storage.threads.get("thread-a");
    // Simulate a pre-retirement project row still active in SQLite.
    storage.memories.create({
      id: "legacy-project-mem",
      scope: "project",
      projectKey: threadA.projectKey,
      originThreadId: "thread-a",
      kind: "decision",
      status: "active",
      topic: "storage-primary",
      content: "在线读写以 SQLite 为准 legacy project row",
      captureKey: "legacy:storage-primary",
      supersessionKey: "decision:storage-primary",
      createdBy: "user",
      authority: "user",
      activation: "query",
    });

    const service = createRecallService({ storage, transcript: emptyTranscript() });
    const agentB = await service.searchForAgent(
      { threadId: "thread-b", invocationId: "inv-b", caller: "mcp" },
      { query: "SQLite 存储", layers: ["memory"], memoryScope: "all" }
    );
    assert.equal(
      agentB.hits.some((hit) => hit.source.memoryId === "legacy-project-mem"),
      false,
      "sibling must not retrieve legacy project product memory"
    );
    assert.equal(
      agentB.hits.some((hit) => hit.metadata?.trust === "durable-memory" && hit.metadata?.scope === "project"),
      false
    );

    const sessionB = await service.searchSession("thread-b", "SQLite 存储", {
      layers: ["memory"],
      memoryScope: "all",
    });
    assert.equal(
      sessionB.hits.some((hit) => hit.memoryId === "legacy-project-mem" || hit.sourceId === "legacy-project-mem"),
      false
    );
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("purge origin thread removes thread memory with the thread", async () => {
  const { storage, dir } = createProjectFixture();
  try {
    const written = storage.memory.createProduct({
      threadId: "thread-a",
      kind: "constraint",
      topic: "no-force-push",
      content: "禁止对 main 使用 force push",
      createdBy: "user",
      writeChannel: "user",
    });
    assert.equal(written.memory.scope, "thread");

    assert.equal(storage.threads.purge("thread-a", { purgedBy: "test" }), true);
    assert.equal(storage.threads.get("thread-a"), null);

    // Thread-owned product memory is not shared; purge clears or hides with thread.
    const remaining = storage.memories.get(written.memory.id);
    // Either deleted with thread or left orphaned but not injectable on B.
    const forB = storage.memory.listActiveForTurn("thread-b", { limit: 20 });
    assert.equal(
      forB.some((m) => m.id === written.memory.id),
      false
    );
    if (remaining) {
      assert.equal(remaining.scope, "thread");
    }
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
