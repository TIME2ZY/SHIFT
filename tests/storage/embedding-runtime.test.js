const assert = require("node:assert/strict");
const test = require("node:test");

const { createStorage } = require("../../src/storage");
const { createEmbeddingRuntime } = require("../../src/storage/embedding-runtime");
const { createRecallService } = require("../../src/storage/recall-service");

function config() {
  return {
    enabled: true,
    provider: "local",
    model: "semantic-test",
    dimensions: 3,
    batchSize: 8,
    timeoutMs: 1000,
    baseUrl: "http://unused",
    apiKey: "",
  };
}

function provider() {
  const vectorFor = (text) =>
    /sqlite|relational authority/i.test(text)
      ? new Float32Array([1, 0, 0])
      : new Float32Array([0, 1, 0]);
  return {
    available: true,
    model: "semantic-test",
    dimensions: 3,
    async embedDocuments(texts) {
      return texts.map(vectorFor);
    },
    async embedQuery(text) {
      return vectorFor(text);
    },
  };
}

test("embedding runtime indexes authoritative writes and enables semantic recall", async () => {
  const storage = createStorage({ file: ":memory:" });
  storage.threads.create({ id: "thread-1", projectDir: process.cwd() });
  const runtime = createEmbeddingRuntime({
    storage,
    config: config(),
    provider: provider(),
    autoStart: false,
    logger: { error() {} },
  });
  try {
    const written = storage.memory.createProduct({
      threadId: "thread-1",
      kind: "decision",
      topic: "storage-authority",
      content: "SQLite is the durable source of truth for online reads and writes.",
      createdBy: "user",
      writeChannel: "user",
      scope: "thread",
    });
    const queued = storage.db
      .prepare("SELECT * FROM embedding_items WHERE source_id = ?")
      .get(written.memory.id);
    assert.equal(queued.status, "pending");

    assert.deepEqual(await runtime.runOnce(), {
      state: "available",
      claimed: 1,
      ready: 1,
      failed: 0,
    });

    const service = createRecallService({
      storage,
      embeddingRuntime: runtime,
      recallMode: "hybrid",
      logger: { error() {}, info() {} },
    });
    const result = await service.searchForAgent(
      { threadId: "thread-1", invocationId: "inv-1" },
      { query: "relational authority", layers: ["memory"] }
    );
    assert.equal(result.hits[0].source.memoryId, written.memory.id);
    assert.deepEqual(result.hits[0].matchedBy, ["vector"]);
    assert.equal(result.hits[0].ranks.vector, 1);
    assert.equal(result.availability.channels.vector.available, true);

    const automatic = await service.retrieveForTurn({
      threadId: "thread-1",
      prompt: "relational authority",
      recentLimit: 1,
      relatedLimit: 2,
      budgetChars: 2000,
      recallMode: "hybrid",
    });
    assert.ok(automatic.items[0].channels.includes("vector"));
    assert.equal(automatic.stats.channels.vector, 1);
  } finally {
    await runtime.close();
    storage.close();
  }
});

test("vector query failure degrades to FTS without failing recall", async () => {
  const storage = createStorage({ file: ":memory:" });
  storage.threads.create({ id: "thread-1", projectDir: process.cwd() });
  const runtime = createEmbeddingRuntime({
    storage,
    config: config(),
    provider: {
      ...provider(),
      async embedQuery() {
        throw new Error("offline");
      },
    },
    autoStart: false,
    logger: { error() {} },
  });
  try {
    storage.memory.createProduct({
      threadId: "thread-1",
      kind: "fact",
      topic: "fallback",
      content: "Fallback keyword remains searchable when vectors are offline.",
      createdBy: "user",
      writeChannel: "user",
      scope: "thread",
    });
    const service = createRecallService({
      storage,
      embeddingRuntime: runtime,
      recallMode: "hybrid",
      logger: { error() {}, info() {} },
    });
    const result = await service.searchForAgent(
      { threadId: "thread-1", invocationId: "inv-1" },
      { query: "Fallback keyword", layers: ["memory"] }
    );
    assert.equal(result.hits.length, 1);
    assert.equal(result.availability.channels.fts.available, true);
    assert.equal(result.availability.channels.vector.available, false);
    assert.equal(result.availability.channels.vector.reason, "vector_query_failed");
  } finally {
    await runtime.close();
    storage.close();
  }
});

test("embedding model change backfills a building generation before atomic activation", async () => {
  const storage = createStorage({ file: ":memory:" });
  storage.threads.create({ id: "thread-switch" });
  const firstRuntime = createEmbeddingRuntime({
    storage,
    config: config(),
    provider: provider(),
    autoStart: false,
    logger: { error() {} },
  });
  try {
    storage.memory.createProduct({
      id: "memory-switch",
      threadId: "thread-switch",
      kind: "decision",
      topic: "storage-authority",
      content: "SQLite is the durable source of truth.",
      createdBy: "user",
      writeChannel: "user",
      scope: "thread",
    });
    await firstRuntime.runOnce();
    const oldGeneration = storage.embeddings.getActiveIndex().generation;
    await firstRuntime.close();

    const nextConfig = { ...config(), model: "semantic-next", dimensions: 4 };
    const nextProvider = {
      available: true,
      model: "semantic-next",
      dimensions: 4,
      async embedDocuments(texts) {
        return texts.map(() => new Float32Array([1, 0, 0, 0]));
      },
      async embedQuery() {
        return new Float32Array([1, 0, 0, 0]);
      },
    };
    const nextRuntime = createEmbeddingRuntime({
      storage,
      config: nextConfig,
      provider: nextProvider,
      autoStart: false,
      logger: { error() {} },
    });
    try {
      assert.ok(nextRuntime.buildingIndex);
      assert.equal(storage.embeddings.getActiveIndex().generation, oldGeneration);
      assert.equal((await nextRuntime.search("authority", ["thread:thread-switch"])).reason, "index_building");

      assert.equal((await nextRuntime.runOnce()).ready, 1);
      const activated = await nextRuntime.runOnce();
      assert.equal(activated.activated, true);
      assert.equal(nextRuntime.buildingIndex, null);
      assert.equal(storage.embeddings.getActiveIndex().model, "semantic-next");
      assert.equal(storage.embeddings.getIndex(oldGeneration).status, "retired");
    } finally {
      await nextRuntime.close();
    }
  } finally {
    storage.close();
  }
});

test("stale superseded items do not block building generation activation", async () => {
  const storage = createStorage({ file: ":memory:" });
  storage.threads.create({ id: "thread-switch" });
  const firstRuntime = createEmbeddingRuntime({
    storage,
    config: config(),
    provider: provider(),
    autoStart: false,
    logger: { error() {} },
  });
  try {
    storage.memory.createProduct({
      id: "memory-old",
      threadId: "thread-switch",
      kind: "decision",
      topic: "storage-authority",
      content: "The old storage authority decision.",
      createdBy: "user",
      writeChannel: "user",
      scope: "thread",
    });
    await firstRuntime.runOnce();
    await firstRuntime.close();

    const nextConfig = { ...config(), model: "semantic-next", dimensions: 4 };
    const nextProvider = {
      available: true,
      model: "semantic-next",
      dimensions: 4,
      async embedDocuments(texts) {
        return texts.map(() => new Float32Array([1, 0, 0, 0]));
      },
      async embedQuery() {
        return new Float32Array([1, 0, 0, 0]);
      },
    };
    const nextRuntime = createEmbeddingRuntime({
      storage,
      config: nextConfig,
      provider: nextProvider,
      autoStart: false,
      logger: { error() {} },
    });
    try {
      const buildingGeneration = nextRuntime.buildingIndex.generation;
      storage.memory.createProduct({
        id: "memory-new",
        threadId: "thread-switch",
        kind: "decision",
        topic: "storage-authority",
        content: "The replacement storage authority decision.",
        createdBy: "user",
        writeChannel: "user",
        scope: "thread",
      });

      assert.equal(storage.memories.get("memory-old").status, "superseded");
      assert.equal(
        storage.db
          .prepare(
            `SELECT status FROM embedding_items
             WHERE source_id = ? AND index_generation = ?`
          )
          .get("memory-old", buildingGeneration).status,
        "stale"
      );

      const requeued = await nextRuntime.runOnce();
      assert.equal(requeued.building, true);
      assert.equal(requeued.remaining, 1);
      assert.equal((await nextRuntime.runOnce()).ready, 1);
      const activated = await nextRuntime.runOnce();
      assert.equal(activated.activated, true);
      assert.equal(nextRuntime.buildingIndex, null);
      assert.equal(storage.embeddings.getActiveIndex().model, "semantic-next");
    } finally {
      await nextRuntime.close();
    }
  } finally {
    storage.close();
  }
});

test("embedding task failure rolls back the authoritative memory write", async () => {
  const storage = createStorage({ file: ":memory:" });
  storage.threads.create({ id: "thread-1" });
  const runtime = createEmbeddingRuntime({
    storage,
    config: config(),
    provider: provider(),
    autoStart: false,
    logger: { error() {} },
  });
  const originalEnqueue = storage.embeddings.enqueue;
  try {
    storage.embeddings.enqueue = () => {
      throw new Error("projection write failed");
    };
    assert.throws(
      () =>
        storage.memory.createProduct({
          threadId: "thread-1",
          kind: "fact",
          topic: "atomicity",
          content: "This authoritative row must roll back with its projection task.",
          createdBy: "user",
          writeChannel: "user",
          scope: "thread",
        }),
      /projection write failed/
    );
    assert.equal(
      storage.db.prepare("SELECT COUNT(*) AS count FROM memory_entries").get().count,
      0
    );
  } finally {
    storage.embeddings.enqueue = originalEnqueue;
    await runtime.close();
    storage.close();
  }
});
