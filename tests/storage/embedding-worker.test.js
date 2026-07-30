const assert = require("node:assert/strict");
const test = require("node:test");
const { createStorage } = require("../../src/storage");
const { createEmbeddingWorker } = require("../../src/storage/embedding-worker");
const {
  loadVectorExtension,
  createVectorIndex,
  searchVector,
} = require("../../src/storage/vector-index");

function createFixture(provider) {
  const storage = createStorage({ file: ":memory:" });
  storage.threads.create({ id: "thread-1" });
  loadVectorExtension(storage.db, { required: true });
  createVectorIndex(storage.db, {
    tableName: "embedding_vec_worker_3",
    dimensions: 3,
  });
  storage.embeddings.registerIndex({
    generation: "worker-3",
    model: "worker-model",
    dimensions: 3,
    tableName: "embedding_vec_worker_3",
  });
  storage.embeddings.activateIndex("worker-3");
  const worker = createEmbeddingWorker({
    db: storage.db,
    repository: storage.embeddings,
    provider,
    workerId: "worker-test",
    transaction: storage.transaction,
    logger: { error() {} },
  });
  return { storage, worker };
}

test("embedding worker writes vectors and marks tasks ready atomically", async () => {
  const provider = {
    available: true,
    model: "worker-model",
    dimensions: 3,
    async embedDocuments(texts) {
      return texts.map(() => new Float32Array([1, 0, 0]));
    },
    async embedQuery() {
      return new Float32Array([1, 0, 0]);
    },
  };
  const { storage, worker } = createFixture(provider);
  try {
    const item = storage.embeddings.enqueue({
      sourceKind: "memory",
      sourceId: "memory-1",
      sourceVersion: "v1",
      scope: "thread",
      ownerThreadId: "thread-1",
      content: "SQLite is authoritative.",
      contentHash: "hash-1",
      model: "worker-model",
      dimensions: 3,
      indexGeneration: "worker-3",
    });
    const result = await worker.runOnce({ limit: 10 });
    assert.deepEqual(result, {
      state: "available",
      claimed: 1,
      ready: 1,
      failed: 0,
    });
    assert.equal(storage.embeddings.get(item.id).status, "ready");
    const hits = searchVector(storage.db, {
      tableName: "embedding_vec_worker_3",
      vector: [1, 0, 0],
      scopeKeys: ["thread:thread-1"],
      limit: 10,
    });
    assert.deepEqual(
      hits.map((hit) => hit.itemId),
      [item.id]
    );
  } finally {
    storage.close();
  }
});

test("embedding worker degrades without claiming when provider is unavailable", async () => {
  const provider = {
    available: false,
    reason: "disabled",
    model: "",
    dimensions: 0,
  };
  const { storage, worker } = createFixture(provider);
  try {
    const result = await worker.runOnce();
    assert.deepEqual(result, {
      state: "degraded",
      reason: "disabled",
      claimed: 0,
      ready: 0,
      failed: 0,
    });
  } finally {
    storage.close();
  }
});

test("embedding worker retries invalid provider output without vector writes", async () => {
  const provider = {
    available: true,
    model: "worker-model",
    dimensions: 3,
    async embedDocuments() {
      return [new Float32Array([1, 0])];
    },
    async embedQuery() {
      return new Float32Array([1, 0]);
    },
  };
  const { storage, worker } = createFixture(provider);
  try {
    const item = storage.embeddings.enqueue({
      sourceKind: "message",
      sourceId: "message-1",
      sourceVersion: "v1",
      scope: "thread",
      ownerThreadId: "thread-1",
      content: "hello",
      contentHash: "hash-1",
      model: "worker-model",
      dimensions: 3,
      indexGeneration: "worker-3",
    });
    const result = await worker.runOnce({ retryMs: 1000 });
    assert.equal(result.state, "degraded");
    assert.equal(result.failed, 1);
    assert.equal(storage.embeddings.get(item.id).status, "failed");
  } finally {
    storage.close();
  }
});
