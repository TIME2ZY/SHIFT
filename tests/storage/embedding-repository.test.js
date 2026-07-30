const assert = require("node:assert/strict");
const test = require("node:test");
const { createStorage } = require("../../src/storage");
const { createEmbeddingRepository } = require("../../src/storage/embedding-repository");

test("embedding repository versions chunks and preserves ready idempotency", () => {
  const storage = createStorage({ file: ":memory:" });
  let now = new Date("2026-07-30T00:00:00.000Z");
  const embeddings = createEmbeddingRepository(storage.db, { clock: () => now });
  try {
    storage.threads.create({ id: "thread-1" });
    embeddings.registerIndex({
      generation: "local-v1-3",
      model: "local-v1",
      dimensions: 3,
      tableName: "embedding_vec_local_v1_3",
    });
    const first = embeddings.enqueue({
      sourceKind: "message",
      sourceId: "message-1",
      sourceVersion: "hash-v1",
      chunkIndex: 0,
      scope: "thread",
      ownerThreadId: "thread-1",
      content: "first content",
      contentHash: "chunk-v1",
      model: "local-v1",
      dimensions: 3,
      indexGeneration: "local-v1-3",
    });
    assert.equal(first.status, "pending");
    assert.equal(first.scopeKey, "thread:thread-1");

    const claimed = embeddings.claimBatch({
      workerId: "worker-1",
      indexGeneration: "local-v1-3",
      now,
      limit: 10,
    });
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].status, "processing");
    assert.equal(claimed[0].attemptCount, 1);
    assert.equal(embeddings.markReady(first.id, "worker-1"), true);

    const unchanged = embeddings.enqueue({
      sourceKind: "message",
      sourceId: "message-1",
      sourceVersion: "hash-v1",
      chunkIndex: 0,
      scope: "thread",
      ownerThreadId: "thread-1",
      content: "first content",
      contentHash: "chunk-v1",
      model: "local-v1",
      dimensions: 3,
      indexGeneration: "local-v1-3",
    });
    assert.equal(unchanged.id, first.id);
    assert.equal(unchanged.status, "ready");

    now = new Date("2026-07-30T00:01:00.000Z");
    const next = embeddings.enqueue({
      sourceKind: "message",
      sourceId: "message-1",
      sourceVersion: "hash-v2",
      chunkIndex: 0,
      scope: "thread",
      ownerThreadId: "thread-1",
      content: "changed content",
      contentHash: "chunk-v2",
      model: "local-v1",
      dimensions: 3,
      indexGeneration: "local-v1-3",
    });
    assert.notEqual(next.id, first.id);
    assert.equal(next.status, "pending");
    assert.equal(embeddings.get(first.id).status, "stale");
  } finally {
    storage.close();
  }
});

test("embedding leases retry failures and recover expired work", () => {
  const storage = createStorage({ file: ":memory:" });
  let now = new Date("2026-07-30T00:00:00.000Z");
  const embeddings = createEmbeddingRepository(storage.db, { clock: () => now });
  try {
    storage.threads.create({ id: "thread-1" });
    embeddings.registerIndex({
      generation: "local-v1-3",
      model: "local-v1",
      dimensions: 3,
      tableName: "embedding_vec_local_v1_3",
    });
    const item = embeddings.enqueue({
      sourceKind: "memory",
      sourceId: "memory-1",
      sourceVersion: "v1",
      scope: "thread",
      ownerThreadId: "thread-1",
      content: "durable memory",
      contentHash: "hash-1",
      model: "local-v1",
      dimensions: 3,
      indexGeneration: "local-v1-3",
    });
    assert.equal(
      embeddings.claimBatch({
        workerId: "worker-1",
        indexGeneration: "local-v1-3",
        now,
        leaseMs: 1000,
      }).length,
      1
    );
    assert.equal(
      embeddings.markFailed(item.id, "worker-1", new Error("temporary"), {
        retryMs: 1000,
      }),
      true
    );
    assert.equal(
      embeddings.claimBatch({
        workerId: "worker-2",
        indexGeneration: "local-v1-3",
        now,
      }).length,
      0
    );

    now = new Date("2026-07-30T00:00:02.000Z");
    const retried = embeddings.claimBatch({
      workerId: "worker-2",
      indexGeneration: "local-v1-3",
      now,
      leaseMs: 1000,
    });
    assert.equal(retried.length, 1);
    assert.equal(retried[0].attemptCount, 2);

    now = new Date("2026-07-30T00:00:04.000Z");
    const recovered = embeddings.claimBatch({
      workerId: "worker-3",
      indexGeneration: "local-v1-3",
      now,
      leaseMs: 1000,
    });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].attemptCount, 3);
  } finally {
    storage.close();
  }
});

test("embedding index activation switches one generation atomically", () => {
  const storage = createStorage({ file: ":memory:" });
  try {
    storage.embeddings.registerIndex({
      generation: "model-a-3",
      model: "model-a",
      dimensions: 3,
      tableName: "embedding_vec_model_a_3",
    });
    storage.embeddings.registerIndex({
      generation: "model-b-4",
      model: "model-b",
      dimensions: 4,
      tableName: "embedding_vec_model_b_4",
    });
    storage.embeddings.activateIndex("model-a-3");
    assert.equal(storage.embeddings.getActiveIndex().generation, "model-a-3");
    storage.embeddings.activateIndex("model-b-4");
    assert.equal(storage.embeddings.getActiveIndex().generation, "model-b-4");
    assert.equal(storage.embeddings.getIndex("model-a-3").status, "retired");
  } finally {
    storage.close();
  }
});
